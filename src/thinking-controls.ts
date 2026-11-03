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
  // Committed input precedes turn.started, so a user part still carries the
  // previous turn's number. It already belongs to the next turn for disclosure
  // purposes; waiting for assistant content would leave the old thought open.
  function newestTurn(parts){
    var newest = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
      var part = parts[i];
      if (!part || typeof part.turnNumber !== 'number') continue;
      var turn = part.turnNumber + (part.kind === 'user' ? 1 : 0);
      if (turn > newest) newest = turn;
    }
    return newest;
  }
`;
