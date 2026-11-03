// The collapsed thought row's preview and the turn that closes it, shared by the
// transcript and the tests so no surface can invent its own truncation rule.
export const THINKING_CONTROLS_JS = String.raw`
  // The preview is the whole thought; the cut is CSS text-overflow so it follows
  // every resize. Only the source is bounded, to keep one unwrapped line cheap to
  // lay out; 2000 characters is wider than any webview.
  var THOUGHT_PREVIEW = 2000;
  function thoughtPreview(text){
    var source = String(text || '');
    return source.length > THOUGHT_PREVIEW ? source.slice(0, THOUGHT_PREVIEW) : source;
  }
  // A forward turn number is a new turn: the prompt just sent, a queued one
  // draining, or an answer landing. Parts without a turn number cannot move it.
  function newestTurn(parts){
    var newest = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
      var part = parts[i];
      if (part && typeof part.turnNumber === 'number' && part.turnNumber > newest) newest = part.turnNumber;
    }
    return newest;
  }
`;
