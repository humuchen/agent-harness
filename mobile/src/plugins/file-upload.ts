/**
 * 文件/照片上传插件封装
 *
 * 通过 Capacitor Camera 选取文件或拍照，
 * 上传到 server POST /api/artifacts（base64 内容）完成落盘归档。
 */
import { Camera, CameraSource, CameraResultType } from '@capacitor/camera';
import { getPlugins } from '../bridge/register-plugins';
import { uploadArtifact, stripDataUrlPrefix } from './artifacts-client';

export interface PickerResult {
  dataUrl: string; // base64 data URL
  name: string;
  mimeType: string;
}

export interface UploadResult {
  ok: boolean;
  artifactId?: string;
  error?: string;
}

export interface FileUploadController {
  /** 从相册选取文件 */
  pickFile(): Promise<PickerResult | null>;
  /** 拍照 */
  takePhoto(): Promise<PickerResult | null>;
  /** 选取并自动上传到 artifacts */
  pickAndUpload(kind?: string): Promise<UploadResult>;
}

export const fileUploadController: FileUploadController = {
  async pickFile() {
    const { isNative } = getPlugins();
    if (!isNative) return null;
    const result = await Camera.getPhoto({
      quality: 80,
      source: CameraSource.Photos,
      resultType: CameraResultType.Base64
    });
    return {
      dataUrl: `data:image/${result.format};base64,${result.base64String ?? ''}`,
      name: `photo_${Date.now()}.${result.format}`,
      mimeType: `image/${result.format}`
    };
  },
  async takePhoto() {
    const { isNative } = getPlugins();
    if (!isNative) return null;
    const result = await Camera.getPhoto({
      quality: 80,
      source: CameraSource.Camera,
      resultType: CameraResultType.Base64
    });
    return {
      dataUrl: `data:image/${result.format};base64,${result.base64String ?? ''}`,
      name: `photo_${Date.now()}.${result.format}`,
      mimeType: `image/${result.format}`
    };
  },
  async pickAndUpload(kind = 'other') {
    const picked = await this.pickFile();
    if (!picked) return { ok: false, error: 'no file selected' };
    const base64 = stripDataUrlPrefix(picked.dataUrl);
    return uploadArtifact({
      name: picked.name,
      contentBase64: base64,
      mimeType: picked.mimeType,
      kind
    });
  }
};
