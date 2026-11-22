import { useState } from "react";
import { usePrefs } from "@/app/state/prefs";
import { toast } from "@/app/state/ui";
import { Button } from "@/components/primitives/Button";
import { Segmented, Switch } from "@/components/primitives/Controls";
import { ConfirmDialog } from "@/components/primitives/Dialog";
import { inTauri, shell } from "@/services/shell";
import { errorMessage } from "@/utils/format";

/** How questions and screenshots reach the chat tabs. Used in the AI chats toolbar and in Settings. */
export function WebChatOptions() {
  const autoQuestions = usePrefs((p) => p.webChatAutoQuestions);
  const autoScreenshots = usePrefs((p) => p.webChatAutoScreenshots);
  const target = usePrefs((p) => p.webChatTarget);
  const set = usePrefs((p) => p.set);
  const [confirm, setConfirm] = useState(false);

  const row = "flex items-center justify-between gap-4 py-3";
  return (
    <div className="flex flex-col divide-y divide-[var(--zhu-border-subtle)]">
      <div className={row}>
        <div className="min-w-0">
          <div className="text-body text-fg">Fill in detected questions</div>
          <div className="text-secondary text-fg-2">While listening, each question is typed into the message box.</div>
        </div>
        <Switch checked={autoQuestions} label="Fill in detected questions in chat tabs" onCheckedChange={(v) => set({ webChatAutoQuestions: v })} />
      </div>
      <div className={row}>
        <div className="min-w-0">
          <div className="text-body text-fg">Attach screenshots</div>
          <div className="text-secondary text-fg-2">Each screenshot you take is added to the draft. Most sites upload it right away.</div>
        </div>
        <Switch checked={autoScreenshots} label="Attach screenshots in chat tabs" onCheckedChange={(v) => set({ webChatAutoScreenshots: v })} />
      </div>
      <div className={row}>
        <div className="min-w-0">
          <div className="text-body text-fg">Send to</div>
        </div>
        <Segmented
          label="Which chat tabs receive questions"
          size="sm"
          value={target}
          onValueChange={(v) => set({ webChatTarget: v })}
          options={[
            { value: "all", label: "All tabs" },
            { value: "active", label: "Only the tab I'm on" },
          ]}
        />
      </div>
      <div className={row}>
        <div className="min-w-0">
          <div className="text-body text-fg">Sign out of all chat sites</div>
          <div className="text-secondary text-fg-2">ZHU never signs in for you and never presses Send.</div>
        </div>
        <Button size="sm" variant="ghost" disabled={!inTauri} onClick={() => setConfirm(true)}>
          Sign out
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out of all chat sites?"
        description="Every chat tab loses its sign-in and you will have to sign in again. Conversations stored by the providers are not deleted."
        confirmLabel="Sign out"
        destructive
        onConfirm={async () => {
          try {
            await shell.webchatClearData();
            toast.success("Signed out of all chat sites");
          } catch (err) {
            toast.error("Could not sign out", errorMessage(err));
          }
        }}
      />
    </div>
  );
}
