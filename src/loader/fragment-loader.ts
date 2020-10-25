import { ErrorTypes, ErrorDetails } from '../errors';
import Fragment from './fragment';
import {
  Loader,
  LoaderConfiguration,
  FragmentLoaderContext,
  LoaderStats
} from '../types/loader';
import type { HlsConfig } from '../config';
import type { BaseSegment, Part } from './fragment';
import type { FragLoadedData } from '../types/events';
import LevelDetails from './level-details';

const MIN_CHUNK_SIZE = Math.pow(2, 17); // 128kb

export default class FragmentLoader {
  private readonly config: HlsConfig;
  private loader: Loader<FragmentLoaderContext> | null = null;
  private partLoadTimeout: number = -1;

  constructor (config: HlsConfig) {
    this.config = config;
  }

  abort () {
    if (this.loader) {
      // Abort the loader for current fragment. Only one may load at any given time
      console.log(`Abort frag loader ${this.loader.context.url}`, this.loader);
      this.loader.abort();
    }
  }

  load (frag: Fragment, levelDetails?: LevelDetails, targetBufferTime: number | null = null, onProgress?: FragmentLoadProgressCallback): Promise<FragLoadedData | null> {
    const config = this.config;
    const FragmentILoader = config.fLoader;
    const DefaultILoader = config.loader;

    this.abort();

    const loader = this.loader = frag.loader =
      FragmentILoader ? new FragmentILoader(config) : new DefaultILoader(config) as Loader<FragmentLoaderContext>;

    const loaderConfig: LoaderConfiguration = {
      timeout: config.fragLoadingTimeOut,
      maxRetry: 0,
      retryDelay: 0,
      maxRetryDelay: config.fragLoadingMaxRetryTimeout,
      highWaterMark: MIN_CHUNK_SIZE
    };

    targetBufferTime = Math.max(frag.start, targetBufferTime || 0);
    const partList = levelDetails?.partList;
    if (partList && onProgress) {
      const partIndex = findIndependentPart(partList, frag, targetBufferTime);
      if (partIndex > -1) {
        console.log(`loadFragmentParts        sn: ${frag.sn} level: ${levelDetails.url}`);
        return this.loadFragmentParts(partList, partIndex, frag, loaderConfig, onProgress);
      } else if (!frag.url) {
        // Fragment hint has no parts
        this.resetLoader(frag, this.loader);
        return Promise.resolve(null);
      }
    }

    const url = frag.url;
    if (!url) {
      return Promise.reject(new LoadError({
        type: ErrorTypes.NETWORK_ERROR,
        details: ErrorDetails.FRAG_LOAD_ERROR,
        fatal: false,
        frag,
        networkDetails: null
      }, `Fragment does not have a ${url ? 'part list' : 'url'}`));
    }

    const loaderContext = createLoaderContext(frag);

    return new Promise((resolve, reject) => {
      // Assign frag stats to the loader's stats reference
      loader.stats = frag.stats;
      loader.load(loaderContext, loaderConfig, {
        onSuccess: (response, stats, context, networkDetails) => {
          this.resetLoader(frag, loader);
          resolve({
            frag,
            payload: response.data as ArrayBuffer,
            networkDetails
          });
        },
        onError: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.FRAG_LOAD_ERROR,
            fatal: false,
            frag,
            response,
            networkDetails
          }));
        },
        onAbort: (stats, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.INTERNAL_ABORTED,
            fatal: false,
            frag,
            networkDetails
          }));
        },
        onTimeout: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.FRAG_LOAD_TIMEOUT,
            fatal: false,
            frag,
            networkDetails
          }));
        },
        onProgress: (stats, context, data, networkDetails) => {
          if (onProgress) {
            onProgress({
              frag,
              payload: data as ArrayBuffer,
              networkDetails
            });
          }
        }
      });
    });
  }

  private loadFragmentParts (partList: Part[], partIndex: number, frag: Fragment, loaderConfig: LoaderConfiguration, onProgress: FragmentLoadProgressCallback): Promise<FragLoadedData> {
    return new Promise((resolve, reject) => {
      const loader = this.loader as Loader<FragmentLoaderContext>;
      this.partLoadTimeout = self.setTimeout(() => {
        this.resetLoader(frag, loader);
        reject(new LoadError({
          type: ErrorTypes.NETWORK_ERROR,
          details: ErrorDetails.FRAG_LOAD_TIMEOUT,
          fatal: false,
          frag,
          part: partList[partIndex],
          networkDetails: loader.loader
        }));
      }, loaderConfig.timeout);

      // TODO: Handle not starting on first part of fragment (what is startPTS?)
      const loadPartIndex = (index: number) => {
        const part = partList[index];
        console.log(`loadPartIndex            sn: ${part.fragment.sn} p: ${part.index} partList[${index}] -----------`);
        this.loadPart(frag, part, loader, loaderConfig, onProgress).then((partLoadedData: FragLoadedData) => {
          const loadedPart = partLoadedData.part as Part;
          if (index >= partList.length - 1) {
            this.resetLoader(frag, loader);
            console.log(`loaded last part in list sn: ${loadedPart.fragment.sn} p: ${loadedPart!.index} partList[${index}]`);
            // TODO: Handle partList update
            //  [ ] - Try resolving with "partial" info
            // return resolve(partLoadedData);
            return reject(new LoadError({
              type: ErrorTypes.NETWORK_ERROR,
              details: ErrorDetails.INTERNAL_ABORTED,
              fatal: false,
              frag,
              part: loadedPart,
              networkDetails: partLoadedData.networkDetails
            }));
          }
          const nextPart = partList[index + 1];
          if (nextPart.fragment !== frag) {
            this.resetLoader(frag, loader);
            console.log(`loaded last part in frag sn: ${nextPart.fragment.sn} p: ${nextPart.index} partList[${index + 1}]`);
            return resolve(partLoadedData);
          }
          console.log(`load next part           sn: ${nextPart.fragment.sn} p: ${nextPart.index} partList[${index + 1}]`);
          loadPartIndex(index + 1);
        }).catch(reject);
      };
      loadPartIndex(partIndex);
    });
  }

  private loadPart (frag: Fragment, part: Part, loader: Loader<FragmentLoaderContext>, loaderConfig: LoaderConfiguration, onProgress: FragmentLoadProgressCallback): Promise<FragLoadedData> {
    console.log(`loadPart                 sn: ${frag.sn} p: ${part.index}`);
    return new Promise((resolve, reject) => {
      const loaderContext = createLoaderContext(frag, part);
      // Assign part stats to the loader's stats reference
      loader.stats = part.stats;
      loader.load(loaderContext, loaderConfig, {
        onSuccess: (response, stats, context, networkDetails) => {
          this.updateStatsFromPart(frag.stats, part.stats);
          const partLoadedData: FragLoadedData = {
            frag,
            part,
            payload: response.data as ArrayBuffer,
            networkDetails
          };
          onProgress(partLoadedData);
          resolve(partLoadedData);
        },
        onError: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.FRAG_LOAD_ERROR,
            fatal: false,
            frag,
            part,
            response,
            networkDetails
          }));
        },
        onAbort: (stats, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.INTERNAL_ABORTED,
            fatal: false,
            frag,
            part,
            networkDetails
          }));
        },
        onTimeout: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.FRAG_LOAD_TIMEOUT,
            fatal: false,
            frag,
            part,
            networkDetails
          }));
        }
      });
    });
  }

  private updateStatsFromPart (fragStats: LoaderStats, partStats: LoaderStats) {
    fragStats.loaded += partStats.loaded;
    fragStats.total += partStats.total;
    const fragLoading = fragStats.loading;
    if (fragLoading.start) {
      fragLoading.start += partStats.loading.start - fragLoading.end;
      fragLoading.first += partStats.loading.first - fragLoading.end;
    } else {
      fragLoading.start = partStats.loading.start;
      fragLoading.first = partStats.loading.first;
    }
    fragLoading.end = partStats.loading.end;
  }

  private resetLoader (frag: Fragment, loader: Loader<FragmentLoaderContext>) {
    frag.loader = null;
    if (this.loader === loader) {
      self.clearTimeout(this.partLoadTimeout);
      this.loader = null;
    }
  }
}

function findIndependentPart (partList: Part[], frag: Fragment, targetBufferTime: number): number {
  let independentPart = -1;
  for (let i = 0, len = partList.length; i < len; i++) {
    const part = partList[i];
    if (targetBufferTime < part.start) {
      break;
    }
    if (part.independent && part.fragment === frag) {
      independentPart = i;
      // FIXME: For now just always return the first part so that we get the correct 'startPTS' for fragment
      break;
    }
  }
  return independentPart;
}

function createLoaderContext (frag: Fragment, part: Part | null = null): FragmentLoaderContext {
  const segment: BaseSegment = part || frag;
  const loaderContext: FragmentLoaderContext = {
    frag,
    part,
    responseType: 'arraybuffer',
    url: segment.url,
    rangeStart: 0,
    rangeEnd: 0
  };
  const start = segment.byteRangeStartOffset;
  const end = segment.byteRangeEndOffset;
  if (Number.isFinite(start) && Number.isFinite(end)) {
    loaderContext.rangeStart = start;
    loaderContext.rangeEnd = end;
  }
  return loaderContext;
}

export class LoadError extends Error {
  public readonly data: FragLoadFailResult;
  constructor (data: FragLoadFailResult, ...params) {
    super(...params);
    this.data = data;
  }
}

export interface FragLoadFailResult {
  type: string
  details: string
  fatal: boolean
  frag: Fragment
  part?: Part
  response?: {
    // error status code
    code: number,
    // error description
    text: string,
  }
  networkDetails: any
}

export type FragmentLoadProgressCallback = (result: FragLoadedData) => void;
