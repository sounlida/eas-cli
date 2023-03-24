import { ExpoConfig, Platform } from '@expo/config';
import { Updates } from '@expo/config-plugins';
import { Platform as EASBuildJobPlatform, Workflow } from '@expo/eas-build-job';
import JsonFile from '@expo/json-file';
import assert from 'assert';
import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs-extra';
import Joi from 'joi';
import mime from 'mime';
import nullthrows from 'nullthrows';
import path from 'path';
import promiseLimit from 'promise-limit';

import { selectBranchOnAppAsync } from '../branch/queries';
import { getDefaultBranchNameAsync } from '../branch/utils';
import { ExpoGraphqlClient } from '../commandUtils/context/contextUtils/createGraphqlClient';
import { PaginatedQueryOptions } from '../commandUtils/pagination';
import { AssetMetadataStatus, PartialManifestAsset } from '../graphql/generated';
import { PublishMutation } from '../graphql/mutations/PublishMutation';
import { PublishQuery } from '../graphql/queries/PublishQuery';
import Log, { learnMore } from '../log';
import { RequestedPlatform, requestedPlatformDisplayNames } from '../platform';
import { promptAsync } from '../prompts';
import { getBranchNameFromChannelNameAsync } from '../update/getBranchNameFromChannelNameAsync';
import { formatUpdateMessage, truncateString as truncateUpdateMessage } from '../update/utils';
import { PresignedPost, uploadWithPresignedPostWithRetryAsync } from '../uploads';
import { expoCommandAsync, shouldUseVersionedExpoCLI } from '../utils/expoCli';
import chunk from '../utils/expodash/chunk';
import { truthy } from '../utils/expodash/filter';
import uniqBy from '../utils/expodash/uniqBy';
import { getVcsClient } from '../vcs';
import { resolveWorkflowAsync } from './workflow';

export type ExpoCLIExportPlatformFlag = Platform | 'all';

type Metadata = {
  version: number;
  bundler: 'metro';
  fileMetadata: {
    [key in Platform]: { assets: { path: string; ext: string }[]; bundle: string };
  };
};
export type RawAsset = {
  fileExtension?: string;
  contentType: string;
  path: string;
  /** Original asset path derrived from asset map, or exported folder */
  originalPath?: string;
};

type CollectedAssets = {
  [platform in Platform]?: {
    launchAsset: RawAsset;
    assets: RawAsset[];
  };
};

type ManifestExtra = {
  expoClient?: { [key: string]: any };
  [key: string]: any;
};
type ManifestFragment = {
  launchAsset: PartialManifestAsset;
  assets: PartialManifestAsset[];
  extra?: ManifestExtra;
};
type UpdateInfoGroup = {
  [key in Platform]: ManifestFragment;
};

// Partial copy of `@expo/dev-server` `BundleAssetWithFileHashes`
type AssetMap = Record<
  string,
  {
    httpServerLocation: string;
    name: string;
    type: string;
  }
>;

const fileMetadataJoi = Joi.object({
  assets: Joi.array()
    .required()
    .items(Joi.object({ path: Joi.string().required(), ext: Joi.string().required() })),
  bundle: Joi.string().required(),
}).optional();
export const MetadataJoi = Joi.object({
  version: Joi.number().required(),
  bundler: Joi.string().required(),
  fileMetadata: Joi.object({
    android: fileMetadataJoi,
    ios: fileMetadataJoi,
    web: fileMetadataJoi,
  }).required(),
}).required();

export function guessContentTypeFromExtension(ext?: string): string {
  return mime.getType(ext ?? '') ?? 'application/octet-stream'; // unrecognized extension
}

export function getBase64URLEncoding(buffer: Buffer): string {
  const base64 = buffer.toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The storage key is used to store the asset in GCS
 */
export function getStorageKey(contentType: string, contentHash: string): string {
  const nullSeparator = Buffer.alloc(1);
  const hash = crypto
    .createHash('sha256')
    .update(contentType)
    .update(nullSeparator)
    .update(contentHash)
    .digest();
  return getBase64URLEncoding(hash);
}

async function calculateFileHashAsync(filePath: string, algorithm: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const file = fs.createReadStream(filePath).on('error', reject);
    const hash = file.pipe(crypto.createHash(algorithm)).on('error', reject);
    hash.on('finish', () => resolve(hash.read()));
  });
}

/**
 * Convenience function that computes an assets storage key starting from its buffer.
 */
export async function getStorageKeyForAssetAsync(asset: RawAsset): Promise<string> {
  const fileSHA256 = getBase64URLEncoding(await calculateFileHashAsync(asset.path, 'sha256'));
  return getStorageKey(asset.contentType, fileSHA256);
}

export async function convertAssetToUpdateInfoGroupFormatAsync(
  asset: RawAsset
): Promise<PartialManifestAsset> {
  const fileSHA256 = getBase64URLEncoding(await calculateFileHashAsync(asset.path, 'sha256'));
  const { contentType, fileExtension } = asset;

  const storageKey = getStorageKey(contentType, fileSHA256);
  const bundleKey = (await calculateFileHashAsync(asset.path, 'md5')).toString('hex');

  return {
    fileSHA256,
    contentType,
    storageKey,
    bundleKey,
    fileExtension,
  };
}

/**
 * This will be sorted later based on the platform's runtime versions.
 */
export async function buildUnsortedUpdateInfoGroupAsync(
  assets: CollectedAssets,
  exp: ExpoConfig
): Promise<UpdateInfoGroup> {
  let platform: Platform;
  const updateInfoGroup: Partial<UpdateInfoGroup> = {};
  for (platform in assets) {
    updateInfoGroup[platform] = {
      launchAsset: await convertAssetToUpdateInfoGroupFormatAsync(assets[platform]?.launchAsset!),
      assets: await Promise.all(
        (assets[platform]?.assets ?? []).map(convertAssetToUpdateInfoGroupFormatAsync)
      ),
      extra: {
        expoClient: exp,
      },
    };
  }
  return updateInfoGroup as UpdateInfoGroup;
}

export async function buildBundlesAsync({
  projectDir,
  inputDir,
  exp,
  platformFlag,
}: {
  projectDir: string;
  inputDir: string;
  exp: Pick<ExpoConfig, 'sdkVersion'>;
  platformFlag: ExpoCLIExportPlatformFlag;
}): Promise<void> {
  const packageJSON = JsonFile.read(path.resolve(projectDir, 'package.json'));
  if (!packageJSON) {
    throw new Error('Could not locate package.json');
  }

  if (shouldUseVersionedExpoCLI(projectDir, exp)) {
    await expoCommandAsync(projectDir, [
      'export',
      '--output-dir',
      inputDir,
      '--dump-sourcemap',
      '--dump-assetmap',
      '--platform',
      platformFlag,
    ]);
  } else {
    // Legacy global Expo CLI
    await expoCommandAsync(projectDir, [
      'export',
      '--output-dir',
      inputDir,
      '--experimental-bundle',
      '--non-interactive',
      '--dump-sourcemap',
      '--dump-assetmap',
      '--platform',
      platformFlag,
    ]);
  }
}

export async function resolveInputDirectoryAsync(
  inputDir: string,
  { skipBundler }: { skipBundler?: boolean }
): Promise<string> {
  const distRoot = path.resolve(inputDir);
  if (!(await fs.pathExists(distRoot))) {
    let error = `--input-dir="${inputDir}" not found.`;
    if (skipBundler) {
      error += ` --skip-bundler requires the project to be exported manually before uploading. Ex: npx expo export && eas update --skip-bundler`;
    }
    throw new Error(error);
  }
  return distRoot;
}

export function loadMetadata(distRoot: string): Metadata {
  const metadata: Metadata = JsonFile.read(path.join(distRoot, 'metadata.json'));
  const { error } = MetadataJoi.validate(metadata);
  if (error) {
    throw error;
  }
  // Check version and bundler by hand (instead of with Joi) so
  // more informative error messages can be returned.
  if (metadata.version !== 0) {
    throw new Error('Only bundles with metadata version 0 are supported');
  }
  if (metadata.bundler !== 'metro') {
    throw new Error('Only bundles created with Metro are currently supported');
  }
  const platforms = Object.keys(metadata.fileMetadata);
  if (platforms.length === 0) {
    Log.warn('No updates were exported for any platform');
  }
  Log.debug(`Loaded ${platforms.length} platform(s): ${platforms.join(', ')}`);
  return metadata;
}

export function filterExportedPlatformsByFlag<T extends Partial<Record<Platform, any>>>(
  record: T,
  platformFlag: ExpoCLIExportPlatformFlag
): T {
  if (platformFlag === 'all') {
    return record;
  }

  const platform = platformFlag as Platform;

  if (!record[platform]) {
    throw new Error(
      `--platform="${platform}" not found in metadata.json. Available platform(s): ${Object.keys(
        record
      ).join(', ')}`
    );
  }

  return { [platform]: record[platform] } as T;
}

/** Try to load the asset map for logging the names of assets published */
export async function loadAssetMapAsync(distRoot: string): Promise<AssetMap | null> {
  const assetMapPath = path.join(distRoot, 'assetmap.json');

  if (!(await fs.pathExists(assetMapPath))) {
    return null;
  }

  const assetMap: AssetMap = JsonFile.read(path.join(distRoot, 'assetmap.json'));
  // TODO: basic validation?
  return assetMap;
}

// exposed for testing
export function getAssetHashFromPath(assetPath: string): string | null {
  const [, hash] = assetPath.match(new RegExp(/assets\/([a-z0-9]+)$/, 'i')) ?? [];
  return hash ?? null;
}

// exposed for testing
export function getOriginalPathFromAssetMap(
  assetMap: AssetMap | null,
  asset: { path: string; ext: string }
): string | null {
  if (!assetMap) {
    return null;
  }
  const assetHash = getAssetHashFromPath(asset.path);
  const assetMapEntry = assetHash && assetMap[assetHash];

  if (!assetMapEntry) {
    return null;
  }

  const pathPrefix = assetMapEntry.httpServerLocation.substring('/assets'.length);
  return `${pathPrefix}/${assetMapEntry.name}.${assetMapEntry.type}`;
}

/** Given a directory, load the metadata.json and collect the assets for each platform. */
export async function collectAssetsAsync(dir: string): Promise<CollectedAssets> {
  const metadata = loadMetadata(dir);
  const assetmap = await loadAssetMapAsync(dir);

  const collectedAssets: CollectedAssets = {};

  for (const platform of Object.keys(metadata.fileMetadata) as Platform[]) {
    collectedAssets[platform] = {
      launchAsset: {
        fileExtension: '.bundle',
        contentType: 'application/javascript',
        path: path.resolve(dir, metadata.fileMetadata[platform].bundle),
      },
      assets: metadata.fileMetadata[platform].assets.map(asset => ({
        fileExtension: asset.ext ? ensureLeadingPeriod(asset.ext) : undefined,
        originalPath: getOriginalPathFromAssetMap(assetmap, asset) ?? undefined,
        contentType: guessContentTypeFromExtension(asset.ext),
        path: path.join(dir, asset.path),
      })),
    };
  }

  return collectedAssets;
}

// ensure the file extension has a '.' prefix
function ensureLeadingPeriod(extension: string): string {
  return extension.startsWith('.') ? extension : `.${extension}`;
}

export async function filterOutAssetsThatAlreadyExistAsync(
  graphqlClient: ExpoGraphqlClient,
  uniqueAssetsWithStorageKey: (RawAsset & { storageKey: string })[]
): Promise<(RawAsset & { storageKey: string })[]> {
  const assetMetadata = await PublishQuery.getAssetMetadataAsync(
    graphqlClient,
    uniqueAssetsWithStorageKey.map(asset => asset.storageKey)
  );
  const missingAssetKeys = assetMetadata
    .filter(result => result.status !== AssetMetadataStatus.Exists)
    .map(result => result.storageKey);

  const missingAssets = uniqueAssetsWithStorageKey.filter(asset => {
    return missingAssetKeys.includes(asset.storageKey);
  });
  return missingAssets;
}

type AssetUploadResult = {
  /** All found assets within the exported folder per platform */
  assetCount: number;
  /** The uploaded JS bundles, per platform */
  launchAssetCount: number;
  /** All unique assets within the exported folder with platforms combined */
  uniqueAssetCount: number;
  /** All unique assets uploaded  */
  uniqueUploadedAssetCount: number;
  /** All (non-launch) asset original paths, used for logging */
  uniqueUploadedAssetPaths: string[];
  /** The asset limit received from the server */
  assetLimitPerUpdateGroup: number;
};

export async function uploadAssetsAsync(
  graphqlClient: ExpoGraphqlClient,
  assetsForUpdateInfoGroup: CollectedAssets,
  projectId: string,
  updateSpinnerText?: (totalAssets: number, missingAssets: number) => void
): Promise<AssetUploadResult> {
  let assets: RawAsset[] = [];
  let platform: keyof CollectedAssets;
  const launchAssets: RawAsset[] = [];
  for (platform in assetsForUpdateInfoGroup) {
    launchAssets.push(assetsForUpdateInfoGroup[platform]!.launchAsset);
    assets = [
      ...assets,
      assetsForUpdateInfoGroup[platform]!.launchAsset,
      ...assetsForUpdateInfoGroup[platform]!.assets,
    ];
  }

  const assetsWithStorageKey = await Promise.all(
    assets.map(async asset => {
      return {
        ...asset,
        storageKey: await getStorageKeyForAssetAsync(asset),
      };
    })
  );
  const uniqueAssets = uniqBy<
    RawAsset & {
      storageKey: string;
    }
  >(assetsWithStorageKey, asset => asset.storageKey);

  const totalAssets = uniqueAssets.length;

  updateSpinnerText?.(totalAssets, totalAssets);
  let missingAssets = await filterOutAssetsThatAlreadyExistAsync(graphqlClient, uniqueAssets);
  const uniqueUploadedAssetCount = missingAssets.length;
  const uniqueUploadedAssetPaths = missingAssets.map(asset => asset.originalPath).filter(truthy);

  const missingAssetChunks = chunk(missingAssets, 100);
  const specifications: string[] = [];
  for (const missingAssets of missingAssetChunks) {
    const { specifications: chunkSpecifications } = await PublishMutation.getUploadURLsAsync(
      graphqlClient,
      missingAssets.map(ma => ma.contentType)
    );
    specifications.push(...chunkSpecifications);
  }

  updateSpinnerText?.(totalAssets, missingAssets.length);

  const assetUploadPromiseLimit = promiseLimit(15);

  const [assetLimitPerUpdateGroup] = await Promise.all([
    PublishQuery.getAssetLimitPerUpdateGroupAsync(graphqlClient, projectId),
    missingAssets.map((missingAsset, i) => {
      assetUploadPromiseLimit(async () => {
        const presignedPost: PresignedPost = JSON.parse(specifications[i]);
        await uploadWithPresignedPostWithRetryAsync(missingAsset.path, presignedPost);
      });
    }),
  ]);

  let timeout = 1;
  while (missingAssets.length > 0) {
    const timeoutPromise = new Promise(resolve =>
      setTimeout(resolve, Math.min(timeout * 1000, 5000))
    ); // linear backoff
    missingAssets = await filterOutAssetsThatAlreadyExistAsync(graphqlClient, missingAssets);
    await timeoutPromise; // await after filterOutAssetsThatAlreadyExistAsync for easy mocking with jest.runAllTimers
    timeout += 1;
    updateSpinnerText?.(totalAssets, missingAssets.length);
  }
  return {
    assetCount: assets.length,
    launchAssetCount: launchAssets.length,
    uniqueAssetCount: uniqueAssets.length,
    uniqueUploadedAssetCount,
    uniqueUploadedAssetPaths,
    assetLimitPerUpdateGroup,
  };
}

export function isUploadedAssetCountAboveWarningThreshold(
  uploadedAssetCount: number,
  assetLimitPerUpdateGroup: number
): boolean {
  const warningThreshold = Math.floor(assetLimitPerUpdateGroup * 0.75);
  return uploadedAssetCount > warningThreshold;
}

export async function getBranchNameForCommandAsync({
  graphqlClient,
  projectId,
  channelNameArg,
  branchNameArg,
  autoFlag,
  nonInteractive,
  paginatedQueryOptions,
}: {
  graphqlClient: ExpoGraphqlClient;
  projectId: string;
  channelNameArg: string | undefined;
  branchNameArg: string | undefined;
  autoFlag: boolean;
  nonInteractive: boolean;
  paginatedQueryOptions: PaginatedQueryOptions;
}): Promise<string> {
  if (channelNameArg && branchNameArg) {
    throw new Error(
      'Cannot specify both --channel and --branch. Specify either --channel, --branch, or --auto.'
    );
  }

  if (channelNameArg) {
    return await getBranchNameFromChannelNameAsync(graphqlClient, projectId, channelNameArg);
  }

  if (branchNameArg) {
    return branchNameArg;
  }

  if (autoFlag) {
    return await getDefaultBranchNameAsync();
  } else if (nonInteractive) {
    throw new Error('Must supply --channel, --branch or --auto when in non-interactive mode.');
  } else {
    let branchName: string;

    try {
      const branch = await selectBranchOnAppAsync(graphqlClient, {
        projectId,
        promptTitle: `Which branch would you like to roll back to embedded on?`,
        displayTextForListItem: updateBranch => ({
          title: `${updateBranch.name} ${chalk.grey(
            `- current update: ${formatUpdateMessage(updateBranch.updates[0])}`
          )}`,
        }),
        paginatedQueryOptions,
      });
      branchName = branch.name;
    } catch {
      // unable to select a branch (network error or no branches for project)
      const { name } = await promptAsync({
        type: 'text',
        name: 'name',
        message: 'No branches found. Provide a branch name:',
        initial: await getDefaultBranchNameAsync(),
        validate: value => (value ? true : 'Branch name may not be empty.'),
      });
      branchName = name;
    }

    assert(branchName, 'Branch name must be specified.');
    return branchName;
  }
}

export async function getUpdateMessageForCommandAsync({
  updateMessageArg,
  autoFlag,
  nonInteractive,
  jsonFlag,
}: {
  updateMessageArg: string | undefined;
  autoFlag: boolean;
  nonInteractive: boolean;
  jsonFlag: boolean;
}): Promise<string> {
  let updateMessage = updateMessageArg;
  if (!updateMessageArg && autoFlag) {
    updateMessage = (await getVcsClient().getLastCommitMessageAsync())?.trim();
  }

  if (!updateMessage) {
    if (nonInteractive) {
      throw new Error('Must supply --message or use --auto when in non-interactive mode');
    }

    const validationMessage = 'publish message may not be empty.';
    if (jsonFlag) {
      throw new Error(validationMessage);
    }
    const { updateMessageLocal } = await promptAsync({
      type: 'text',
      name: 'updateMessageLocal',
      message: `Provide an roll back message:`,
      initial: (await getVcsClient().getLastCommitMessageAsync())?.trim(),
      validate: (value: any) => (value ? true : validationMessage),
    });
    updateMessage = updateMessageLocal;
  }

  assert(updateMessage, 'Update message must be specified.');

  const truncatedMessage = truncateUpdateMessage(updateMessage, 1024);
  if (truncatedMessage !== updateMessage) {
    Log.warn('Update message exceeds the allowed 1024 character limit. Truncating message...');
  }

  return updateMessage;
}

export const defaultPublishPlatforms: Platform[] = ['android', 'ios'];

export function getRequestedPlatform(
  platform: ExpoCLIExportPlatformFlag
): RequestedPlatform | null {
  switch (platform) {
    case 'android':
      return RequestedPlatform.Android;
    case 'ios':
      return RequestedPlatform.Ios;
    case 'web':
      return null;
    case 'all':
      return RequestedPlatform.All;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

/** Get runtime versions grouped by platform. Runtime version is always `null` on web where the platform is always backwards compatible. */
export async function getRuntimeVersionObjectAsync(
  exp: ExpoConfig,
  platforms: Platform[],
  projectDir: string
): Promise<{ platform: string; runtimeVersion: string }[]> {
  for (const platform of platforms) {
    if (platform === 'web') {
      continue;
    }
    const isPolicy = typeof (exp[platform]?.runtimeVersion ?? exp.runtimeVersion) === 'object';
    if (isPolicy) {
      const isManaged =
        (await resolveWorkflowAsync(projectDir, platform as EASBuildJobPlatform)) ===
        Workflow.MANAGED;
      if (!isManaged) {
        throw new Error(
          'Runtime version policies are only supported in the managed workflow. In the bare workflow, runtime version needs to be set manually.'
        );
      }
    }
  }

  return [...new Set(platforms)].map(platform => {
    if (platform === 'web') {
      return { platform: 'web', runtimeVersion: 'UNVERSIONED' };
    }
    return {
      platform,
      runtimeVersion: nullthrows(
        Updates.getRuntimeVersion(exp, platform),
        `Unable to determine runtime version for ${
          requestedPlatformDisplayNames[platform]
        }. ${learnMore('https://docs.expo.dev/eas-update/runtime-versions/')}`
      ),
    };
  });
}

export function getRuntimeToPlatformMappingFromRuntimeVersions(
  runtimeVersions: { platform: string; runtimeVersion: string }[]
): { runtimeVersion: string; platforms: string[] }[] {
  const runtimeToPlatformMapping: { runtimeVersion: string; platforms: string[] }[] = [];
  for (const runtime of runtimeVersions) {
    const platforms = runtimeVersions
      .filter(({ runtimeVersion }) => runtimeVersion === runtime.runtimeVersion)
      .map(({ platform }) => platform);
    if (!runtimeToPlatformMapping.find(item => item.runtimeVersion === runtime.runtimeVersion)) {
      runtimeToPlatformMapping.push({ runtimeVersion: runtime.runtimeVersion, platforms });
    }
  }
  return runtimeToPlatformMapping;
}
