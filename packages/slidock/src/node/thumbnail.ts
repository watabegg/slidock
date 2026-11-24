import {
  generateThumbnails as generate,
  prepareBuildThumbnails as prepare,
} from './internal/thumbnails.mjs';

export interface Thumbnail {
  id: string;
  src: string;
  width: number;
  height: number;
}

export interface GenerateThumbnailsOptions {
  siteRoot: string;
  basePath?: string;
  outputWidth?: number;
  outputHeight?: number;
  chromiumExecutable?: string;
}

export interface PrepareBuildThumbnailsOptions {
  siteRoot: string;
  mode: 'auto' | 'none';
  covers: Record<string, string>;
  outputWidth?: number;
  outputHeight?: number;
  chromiumExecutable?: string;
  allowEmpty?: boolean;
  basePath?: string;
}

export interface BuildThumbnail extends Thumbnail {
  asset: string;
}

export async function generateThumbnails(options: GenerateThumbnailsOptions): Promise<Thumbnail[]> {
  return generate(options);
}

export async function prepareBuildThumbnails(
  options: PrepareBuildThumbnailsOptions,
): Promise<BuildThumbnail[]> {
  return prepare(options);
}
