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
