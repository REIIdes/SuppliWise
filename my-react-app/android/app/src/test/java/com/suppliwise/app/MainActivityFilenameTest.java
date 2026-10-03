package com.suppliwise.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MainActivityFilenameTest {
    @Test
    public void pathSegmentsCannotEscapeDownloadsDirectory() {
        String name = SafeDownloadName.fromContentDisposition(
            "attachment; filename=\"../../private/report.pdf\"",
            "SuppliWise_Report.pdf"
        );

        assertFalse(name.contains("/"));
        assertFalse(name.contains("\\"));
        assertEquals(".._.._private_report.pdf", name);
    }

    @Test
    public void encodedAndBackslashTraversalAreReducedToBasenames() {
        String encoded = SafeDownloadName.fromContentDisposition(
            "attachment; filename*=UTF-8''%2e%2e%5csecret.txt",
            "fallback.txt"
        );
        String backslash = SafeDownloadName.fromContentDisposition(
            "attachment; filename=\"..\\..\\secret.txt\"",
            "fallback.txt"
        );

        assertFalse(encoded.contains("/"));
        assertFalse(encoded.contains("\\"));
        assertFalse(backslash.contains("/"));
        assertFalse(backslash.contains("\\"));
        assertTrue(encoded.endsWith("secret.txt"));
        assertTrue(backslash.endsWith("secret.txt"));
    }

    @Test
    public void controlCharactersAndOverlongNamesAreBounded() {
        StringBuilder longName = new StringBuilder("attachment; filename=\"\u0000");
        for (int i = 0; i < 500; i++) longName.append('x');
        longName.append(".pdf\"");

        String name = SafeDownloadName.fromContentDisposition(longName.toString(), "fallback.pdf");

        assertTrue(name.length() <= SafeDownloadName.MAX_LENGTH);
        assertTrue(name.endsWith(".pdf"));
        assertFalse(name.contains("\u0000"));
    }

    @Test
    public void emptyOrDotNamesUseTheFixedFallback() {
        assertEquals(SafeDownloadName.DEFAULT,
            SafeDownloadName.fromContentDisposition("attachment; filename=\"..\"", "fallback.txt"));
        assertEquals("fallback.txt", SafeDownloadName.fromContentDisposition(null, "fallback.txt"));
        assertEquals("report.pdf", SafeDownloadName.fromContentDisposition(null, "https://example.test/files/report.pdf?x=1"));
    }
}
