// Starts the test-only Google stand-in for Playwright (see fake-google.mjs).
import { startFakeGoogleServer } from "./fake-google.mjs";

startFakeGoogleServer(Number(process.env.FAKE_GOOGLE_PORT ?? 3297));
