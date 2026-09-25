package com.suppliwise.app;

import android.os.Bundle;
import android.webkit.DownloadListener;
import android.webkit.WebView;
import android.app.DownloadManager;
import android.net.Uri;
import android.os.Environment;
import android.widget.Toast;
import android.util.Base64;
import android.content.ContentValues;
import android.provider.MediaStore;
import android.os.Build;
import java.io.OutputStream;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Enable download support in WebView
        getBridge().getWebView().setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, 
                                       String mimeType, long contentLength) {
                try {
                    // Handle data URIs (for PDFs generated in-app)
                    if (url.startsWith("data:")) {
                        handleDataUri(url, contentDisposition);
                        return;
                    }
                    
                    // Handle regular URLs. DownloadManager must never receive a
                    // file://, content://, or other unexpected scheme from a
                    // WebView callback.
                    Uri sourceUri = Uri.parse(url);
                    String scheme = sourceUri.getScheme();
                    if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
                        throw new IllegalArgumentException("Unsupported download URL scheme");
                    }

                    DownloadManager.Request request = new DownloadManager.Request(sourceUri);
                    request.setMimeType(mimeType == null || mimeType.trim().isEmpty()
                        ? "application/octet-stream" : mimeType.trim());

                    // Header and URL values are untrusted. SafeDownloadName
                    // parses them and reduces them to a bounded basename.
                    String filename = SafeDownloadName.fromContentDisposition(contentDisposition, url);

                    request.setTitle(filename);
                    request.setDescription("Downloading " + filename);
                    request.allowScanningByMediaScanner();
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
                    
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    dm.enqueue(request);
                    
                    Toast.makeText(getApplicationContext(), "Downloading...", Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    e.printStackTrace();
                    Toast.makeText(getApplicationContext(), "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        });
    }
    
    private void handleDataUri(String dataUri, String contentDisposition) {
        try {
            // Extract filename from content disposition or use default
            String filename = SafeDownloadName.fromContentDisposition(contentDisposition, "SuppliWise_Report.pdf");
            
            // Parse data URI: data:application/pdf;base64,<data>
            String[] parts = dataUri.split(",");
            if (parts.length != 2) {
                throw new Exception("Invalid data URI format");
            }
            
            String base64Data = parts[1];
            byte[] pdfBytes = Base64.decode(base64Data, Base64.DEFAULT);
            
            // Use MediaStore API for Android 10+ (scoped storage)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1); // Mark as pending while writing
                
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    OutputStream outputStream = getContentResolver().openOutputStream(uri);
                    if (outputStream != null) {
                        outputStream.write(pdfBytes);
                        outputStream.close();
                        
                        // Mark file as complete (no longer pending)
                        values.clear();
                        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        getContentResolver().update(uri, values, null, null);
                        
                        // Show notification with action to open file
                        showDownloadNotification(filename, uri);
                        
                        Toast.makeText(getApplicationContext(), "PDF saved to Downloads", Toast.LENGTH_LONG).show();
                    } else {
                        throw new Exception("Could not open output stream");
                    }
                } else {
                    throw new Exception("Could not create file in Downloads");
                }
            } else {
                // Legacy approach for Android 9 and below. Resolve both paths
                // before opening the stream so a symlink or unexpected basename
                // cannot escape the Downloads directory.
                java.io.File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!downloadsDir.exists() && !downloadsDir.mkdirs()) {
                    throw new Exception("Could not create Downloads directory");
                }
                java.io.File canonicalDownloadsDir = downloadsDir.getCanonicalFile();
                java.io.File pdfFile = new java.io.File(canonicalDownloadsDir, filename).getCanonicalFile();
                String rootPath = canonicalDownloadsDir.getPath();
                String filePath = pdfFile.getPath();
                if (!filePath.equals(rootPath)
                    && !filePath.startsWith(rootPath + java.io.File.separator)) {
                    throw new Exception("Unsafe download destination");
                }

                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(pdfFile)) {
                    fos.write(pdfBytes);
                }
                
                // Notify media scanner
                android.media.MediaScannerConnection.scanFile(
                    this,
                    new String[]{pdfFile.getAbsolutePath()},
                    new String[]{"application/pdf"},
                    null
                );
                
                // Notify download manager
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                dm.addCompletedDownload(
                    filename,
                    "SuppliWise Report",
                    true,
                    "application/pdf",
                    pdfFile.getAbsolutePath(),
                    pdfBytes.length,
                    true
                );
                
                Toast.makeText(getApplicationContext(), "PDF saved to Downloads", Toast.LENGTH_LONG).show();
            }
        } catch (Exception e) {
            e.printStackTrace();
            Toast.makeText(getApplicationContext(), "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
    
    private void showDownloadNotification(String filename, Uri fileUri) {
        try {
            // Create intent to open the PDF
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(fileUri, "application/pdf");
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            
            android.app.PendingIntent pendingIntent = android.app.PendingIntent.getActivity(
                this,
                0,
                intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
            );
            
            // Build notification
            android.app.NotificationManager notificationManager = 
                (android.app.NotificationManager) getSystemService(android.content.Context.NOTIFICATION_SERVICE);
            
            String channelId = "pdf_download_channel";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.NotificationChannel channel = new android.app.NotificationChannel(
                    channelId,
                    "PDF Downloads",
                    android.app.NotificationManager.IMPORTANCE_DEFAULT
                );
                notificationManager.createNotificationChannel(channel);
            }
            
            android.app.Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new android.app.Notification.Builder(this, channelId);
            } else {
                builder = new android.app.Notification.Builder(this);
            }
            
            builder.setSmallIcon(android.R.drawable.stat_sys_download_done)
                   .setContentTitle("Download complete")
                   .setContentText(filename)
                   .setContentIntent(pendingIntent)
                   .setAutoCancel(true);
            
            notificationManager.notify(1, builder.build());
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
    
}
