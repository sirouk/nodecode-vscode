// How a message meets a busy thread: steer the live turn when it has a target,
// otherwise queue for the next one, the way the CLI does. Shared by the webview,
// the panel and the controller so no surface can refuse a message.
export type SendDecision = { mode: "steer"; turnId: string } | { mode: "queue" } | { mode: null };

export interface SendView {
  running?: boolean;
  activeTurnId?: string | null;
  activeTurnSteerable?: boolean;
}

export function decideSend(view: SendView | null | undefined): SendDecision {
  if (!view) return { mode: null };
  if (view.activeTurnSteerable && typeof view.activeTurnId === "string" && view.activeTurnId) return { mode: "steer", turnId: view.activeTurnId };
  if (view.running || view.activeTurnId) return { mode: "queue" };
  return { mode: null };
}

export const SEND_CONTROLS_JS = String.raw`
  function decideSend(view){
    if(!view)return {mode:null};
    if(view.activeTurnSteerable&&typeof view.activeTurnId==='string'&&view.activeTurnId)return {mode:'steer',turnId:view.activeTurnId};
    if(view.running||view.activeTurnId)return {mode:'queue'};
    return {mode:null};
  }
`;
