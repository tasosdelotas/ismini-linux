// live-tts.js — Browser-native TTS for ismini WebUI
// All exports are at module level (not trapped in closures)

/**
 * Creates a tracker that accumulates streamed response text
 * and returns the complete text when finished.
 */
export function createLiveResponseTracker() {
  let active = false;
  let response = "";
  return {
    begin() {
      active = true;
      response = "";
    },
    update(text) {
      if (active) response = String(text ?? "");
    },
    finish() {
      if (!active) return "";
      active = false;
      const finished = response;
      response = "";
      return finished;
    },
    cancel() {
      active = false;
      response = "";
    },
  };
}

/**
 * Speaks the given text aloud using the browser's native SpeechSynthesis API.
 * Cancels any currently playing speech before starting new utterance.
 * @param {string} text - The text to speak
 * @param {object} [options] - Optional speech parameters
 * @param {number} [options.rate=1.0] - Speech rate (0.1 to 10)
 * @param {number} [options.pitch=1.0] - Speech pitch (0 to 2)
 * @param {string} [options.voice] - Voice name to use (if available)
 */
export function speakText(text, options = {}) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  if (!text || typeof text !== "string") return;

  // Cancel any ongoing speech
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = Number(options.rate) || 1.0;
  utterance.pitch = Number(options.pitch) || 1.0;

  if (options.voice) {
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find(
      (v) => v.name === options.voice || v.lang === options.voice
    );
    if (match) utterance.voice = match;
  }

  window.speechSynthesis.speak(utterance);
}

/**
 * Immediately stops any active speech synthesis.
 */
export function stopSpeaking() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}
