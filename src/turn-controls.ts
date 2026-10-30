// The Stop control's decision, shared by the button, the status line and the
// tests so a surface can never offer a stop it cannot send.
export const STOP_CONTROLS_JS = String.raw`
  function stopTarget(view,replayReady,connection){
    return view&&view.running&&!view.cached&&view.activeTurnId&&replayReady&&connection==='connected'?view.activeTurnId:null;
  }
  function stopPending(stopping,turnId){return !!stopping&&stopping===turnId;}
`;
