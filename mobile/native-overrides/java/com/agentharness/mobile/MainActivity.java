package com.agentharness.mobile;

import android.app.DownloadManager;
import android.content.Context;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import java.net.URLDecoder;
import java.util.Collections;

/**
 * 自定义 WebView 行为（cap add 重新生成 android/ 时会重置为 Capacitor 模板；
 * 正本维护在 mobile/native-overrides/java/com/agentharness/mobile/MainActivity.java，
 * 由 harden-android.mjs 在 sync 链尾幂等回打）。
 */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webview = getBridge().getWebView();
            // Android 上文档视口（最外层）的滚动条是 WebView 这个 View 的平台级滚动条
            // （View 层绘制，滚动手势时出现）。CSS 的 scrollbar-width / ::-webkit-scrollbar
            // 对文档级滚动容器无效，必须在此关闭。只关滚动条指示器，不影响 web 层自身滚动。
            webview.setVerticalScrollBarEnabled(false);
            webview.setHorizontalScrollBarEnabled(false);
            // 附件下载兜底（交付文件手机端「下载无反应」修复）：Capacitor 8 的 WebView
            // 没有设置任何 DownloadListener，服务端带 Content-Disposition: attachment 的
            // 响应（如 GET /api/artifacts/:id?download=1）会被静默吞掉——用户感知为
            // 「点『下载』无任何反应」。此处接系统 DownloadManager：
            // - 显式复制 WebView 的登录 cookie（下载请求由系统下载服务代发，不会自动带
            //   WebView 的 ah_auth cookie，缺失会 401）；
            // - 按 content-disposition / mimeType 推断本地文件名；服务端 filename 经
            //   encodeURIComponent 编码，DownloadManager 不做百分号解码，中文会落成
            //   %XX 串，这里兜底解码一次；
            // - 落到系统 Download/ 目录并入队，Toast 给出可见反馈（开始/失败都不无声）。
            // targetSdk 36 下经 DownloadManager 写系统下载目录无需存储权限。
            webview.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
                try {
                    DownloadManager.Request request =
                            new DownloadManager.Request(Uri.parse(url));
                    String cookie = CookieManager.getInstance().getCookie(url);
                    if (cookie != null && !cookie.isEmpty()) {
                        request.addRequestHeader("cookie", cookie);
                    }
                    if (userAgent != null && !userAgent.isEmpty()) {
                        request.addRequestHeader("User-Agent", userAgent);
                    }
                    String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    try {
                        fileName = URLDecoder.decode(fileName, "UTF-8");
                    } catch (Exception ignored) {
                        // 文件名本身含 % 转义失败时按原样落盘，不影响下载
                    }
                    request.setDestinationInExternalPublicDir(
                            Environment.DIRECTORY_DOWNLOADS, fileName);
                    request.setNotificationVisibility(
                            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    DownloadManager dm =
                            (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm == null) {
                        Toast.makeText(this, "系统下载服务不可用，请在浏览器中打开下载", Toast.LENGTH_LONG)
                                .show();
                        return;
                    }
                    dm.enqueue(request);
                    Toast.makeText(this, "已开始下载：" + fileName, Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    // 入队异常也不能无声吞掉——用户必须看到失败原因而非「点了没反应」。
                    Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
            // 抽屉侧滑关闭 vs 系统返回手势（Android 10+ 左右边缘内滑返回）的冲突协调：
            // webapp 的 utils/system-gesture.ts 在抽屉打开期间经本接口申请排除区。
            // 排除区只作用于系统返回手势（不影响底部 Home 手势），抽屉关闭即解除。
            webview.addJavascriptInterface(new AhSystemGestureBridge(), "AhSystemGesture");
        }
    }

    /**
     * JS 桥：供 webapp（window.AhSystemGesture）在抽屉打开/关闭时调用的系统手势排除开关。
     *
     * 安全说明：接口暴露给 WebView 内加载的全部内容（含 OAuth 白名单内的第三方授权页），
     * 但能力仅限「开/关系统返回手势排除区」，不触及凭据、文件与网络，与既有
     * DownloadListener 属同一信任级别。JSInterface 方法运行在 JavaBridge 后台线程，
     * View 操作统一 runOnUiThread 切回主线程。
     */
    private final class AhSystemGestureBridge {
        @JavascriptInterface
        public void setDrawerGestureExclusion(final boolean enabled) {
            runOnUiThread(() -> applyDrawerGestureExclusion(enabled));
        }
    }

    /**
     * 登记/解除系统返回手势排除区。
     * setSystemGestureExclusionRects 自 API 29（Android 10）提供——恰是系统返回手势
     * （边缘内滑）引入的版本，低版本没有该系统手势，无需排除。
     */
    private void applyDrawerGestureExclusion(boolean enabled) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        WebView webview = getBridge() != null ? getBridge().getWebView() : null;
        if (webview == null) return;
        if (enabled) {
            // 全屏排除：抽屉打开期间系统返回手势在整个 WebView 区域不触发，
            // 触摸全部交给应用（web 层此时正消费侧滑关闭手势）。
            Rect full = new Rect(0, 0, webview.getWidth(), webview.getHeight());
            webview.setSystemGestureExclusionRects(Collections.singletonList(full));
        } else {
            webview.setSystemGestureExclusionRects(Collections.<Rect>emptyList());
        }
    }
}
