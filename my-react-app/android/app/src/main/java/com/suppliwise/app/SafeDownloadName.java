package com.suppliwise.app;

import java.net.URI;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Safe basename parsing for WebView download headers. */
final class SafeDownloadName {
    static final int MAX_LENGTH = 120;
    static final String DEFAULT = "SuppliWise_Download";

    private static final Pattern FILENAME_STAR = Pattern.compile(
        "(?i)(?:^|;)\\s*filename\\*\\s*=\\s*(?:\\\"([^\\\"]*)\\\"|([^;]*))");
    private static final Pattern FILENAME = Pattern.compile(
        "(?i)(?:^|;)\\s*filename\\s*=\\s*(?:\\\"([^\\\"]*)\\\"|([^;]*))");

    private SafeDownloadName() {}

    /**
     * Parse a Content-Disposition filename without allowing header syntax,
     * path separators, or URL-encoded separators to reach a filesystem sink.
     */
    static String fromContentDisposition(String contentDisposition, String fallback) {
        String candidate = null;
        if (contentDisposition != null) {
            Matcher encoded = FILENAME_STAR.matcher(contentDisposition);
            if (encoded.find()) {
                candidate = firstNonNull(encoded.group(1), encoded.group(2));
                int firstQuote = candidate == null ? -1 : candidate.indexOf('\'');
                if (firstQuote >= 0) {
                    int secondQuote = candidate.indexOf('\'', firstQuote + 1);
                    if (secondQuote > firstQuote) {
                        int valueStart = (secondQuote == firstQuote + 1)
                            ? secondQuote + 1 // RFC 5987: charset'language'value
                            : firstQuote + 1;
                        candidate = candidate.substring(valueStart);
                    }
                }
                if (candidate != null) {
                    try {
                        candidate = URLDecoder.decode(candidate, "UTF-8");
                    } catch (Exception ignored) {
                        // The basename sanitizer below remains authoritative.
                    }
                }
            } else {
                Matcher plain = FILENAME.matcher(contentDisposition);
                if (plain.find()) candidate = firstNonNull(plain.group(1), plain.group(2));
            }
        }

        if (candidate == null || candidate.trim().isEmpty()) candidate = urlBasename(fallback);
        return safeBasename(candidate, DEFAULT);
    }

    private static String firstNonNull(String first, String second) {
        return first != null ? first : second;
    }

    private static String urlBasename(String value) {
        try {
            String path = new URI(value == null ? "" : value).getPath();
            if (path != null && !path.isEmpty()) {
                int slash = path.lastIndexOf('/');
                if (slash >= 0 && slash + 1 < path.length()) return path.substring(slash + 1);
            }
        } catch (Exception ignored) {
            // Use the fixed fallback below.
        }
        return value;
    }

    static String safeBasename(String raw, String fallback) {
        String value = raw == null ? "" : raw;
        try {
            if (value.contains("%")) value = URLDecoder.decode(value, "UTF-8");
        } catch (Exception ignored) {
            // Continue with the undecoded value; separators are still removed.
        }

        // A filename is a basename, never a path. Reject separators and all
        // control characters rather than attempting to interpret them.
        value = value.replaceAll("[\\\\/:*?\\\"<>|\\p{Cntrl}]", "_").trim();
        if (value.isEmpty() || ".".equals(value) || "..".equals(value)) value = fallback;
        if (value.length() > MAX_LENGTH) {
            int dot = value.lastIndexOf('.');
            if (dot > 0 && value.length() - dot <= 12) {
                String extension = value.substring(dot);
                value = value.substring(0, MAX_LENGTH - extension.length()) + extension;
            } else {
                value = value.substring(0, MAX_LENGTH);
            }
        }
        return value;
    }
}
