package com.agentharness.mobile;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import java.net.URLDecoder;

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
        }
    }
}
