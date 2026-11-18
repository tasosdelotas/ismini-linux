// live-tts.js — Browser-native TTS helpers for the ismini WebUI.
//
// The UI (web/index.html) owns the actual speech: it has its own speak()/startTTS()
// with markdown stripping, a voice-index selector, and onend/onerror handling. This
// module provides only the response tracker that accumulates a streamed answer so the
// UI can hand the complete text to TTS when the turn finishes. (The old speakText() /
// stopSpeaking() exports here were never imported by the UI — dead code, removed.)

/**
 * Creates a tracker that captures the current full bubble text as it streams and
 * returns the complete text when the turn finishes. The UI accumulates the streamed
 * tokens into `liveText` itself and calls update(liveText) with the WHOLE bubble text
 * on each token — so update() REPLACES (not appends). Callers that pass incremental
 * chunks should use append() instead.
 */
export function createLiveResponseTracker() {
  let active = false;
  let response = "";
  return {
    begin() {
      active = true;
      response = "";
    },
    // Replace with the full text-so-far (the UI's normal path).
    update(text) {
      if (active) response = String(text ?? "");
    },
    // Append an incremental chunk (for callers that stream fragments, not the whole bubble).
    append(chunk) {
      if (active) response += String(chunk ?? "");
    },
    isActive() {
      return active;
    },
    finish() {
      if (!active) return "";
      active = false;
      const finished = response;
      response = "";
      return finished;
    },
    // Cancel tracking AND stop any in-flight speech: the Pause/error/reset paths call
    // cancel(), and without this the previous answer would keep talking over the new one.
    cancel() {
      active = false;
      response = "";
      if (typeof window !== "undefined" && window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch {}
      }
    },
  };
}
