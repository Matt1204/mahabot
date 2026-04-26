import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ffmpegInstallHint } from "../../src/gateway/ingress/ffmpegAudioConverter.ts";

describe("ffmpegInstallHint", () => {
  test("provides macOS and Windows install guidance", () => {
    assert.match(ffmpegInstallHint("darwin"), /brew install ffmpeg/);
    assert.match(ffmpegInstallHint("win32"), /winget install Gyan\.FFmpeg/);
  });
});
