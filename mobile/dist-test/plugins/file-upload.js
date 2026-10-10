"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileUploadController = void 0;
/**
 * 文件/照片上传插件封装
 *
 * 通过 Capacitor Camera 选取文件或拍照，
 * 上传到 server POST /api/artifacts（base64 内容）完成落盘归档。
 */
const camera_1 = require("@capacitor/camera");
const register_plugins_1 = require("../bridge/register-plugins");
const artifacts_client_1 = require("./artifacts-client");
exports.fileUploadController = {
    async pickFile() {
        const { isNative } = (0, register_plugins_1.getPlugins)();
        if (!isNative)
            return null;
        const result = await camera_1.Camera.getPhoto({
            quality: 80,
            source: camera_1.CameraSource.Photos,
            resultType: camera_1.CameraResultType.Base64
        });
        return {
            dataUrl: `data:image/${result.format};base64,${result.base64String ?? ''}`,
            name: `photo_${Date.now()}.${result.format}`,
            mimeType: `image/${result.format}`
        };
    },
    async takePhoto() {
        const { isNative } = (0, register_plugins_1.getPlugins)();
        if (!isNative)
            return null;
        const result = await camera_1.Camera.getPhoto({
            quality: 80,
            source: camera_1.CameraSource.Camera,
            resultType: camera_1.CameraResultType.Base64
        });
        return {
            dataUrl: `data:image/${result.format};base64,${result.base64String ?? ''}`,
            name: `photo_${Date.now()}.${result.format}`,
            mimeType: `image/${result.format}`
        };
    },
    async pickAndUpload(kind = 'other') {
        const picked = await this.pickFile();
        if (!picked)
            return { ok: false, error: 'no file selected' };
        const base64 = (0, artifacts_client_1.stripDataUrlPrefix)(picked.dataUrl);
        return (0, artifacts_client_1.uploadArtifact)({
            name: picked.name,
            contentBase64: base64,
            mimeType: picked.mimeType,
            kind
        });
    }
};
