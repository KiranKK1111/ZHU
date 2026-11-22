import { useQuery } from "@tanstack/react-query";
import { Download, History, MoreHorizontal, Pencil, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { useSession } from "@/app/state/session";
import { toast, useNav } from "@/app/state/ui";
import { Button, IconButton } from "@/components/primitives/Button";
import { ConfirmDialog, Modal } from "@/components/primitives/Dialog";
import { EmptyState, ErrorState, Skeleton } from "@/components/primitives/Display";
import { Input } from "@/components/primitives/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/primitives/Menu";
import { useDebounced } from "@/hooks/useMisc";
import { api } from "@/services/engine";
import { saveTextFile } from "@/services/shell";
import type { Session } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage, formatDate, formatTime } from "@/utils/format";

/** Past sessions. Open one to see its questions and answers on Home again; export or delete it here. */
export default function HistoryScreen() {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const sessions = useQuery({ queryKey: qk.sessions(q, "recent"), queryFn: () => api.sessions({ query: q, sort: "recent", limit: 500 }) });
  const current = useSession((s) => s.currentSessionId);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const list = sessions.data ?? [];

  const open = (s: Session) => {
    useSession.getState().setCurrentSession(s.id);
    useNav.getState().navigate("home");
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-6 py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="zhu-display text-page text-fg">History</h1>
            <p className="mt-1 text-secondary text-fg-2">Every time you listen, the questions and answers are kept here, on this computer.</p>
          </div>
          <Input leading={<Search className="h-3.5 w-3.5" />} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search history" className="w-64" />
        </div>

        {sessions.isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : sessions.isError ? (
          <ErrorState message={errorMessage(sessions.error)} onRetry={() => void sessions.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState icon={<History className="h-5 w-5" />} title={q ? "Nothing matches your search" : "Nothing here yet"} description={q ? "Try a different word." : "Your sessions appear here after you listen for the first time."} />
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Sessions">
            {list.map((s) => (
              <li key={s.id} className={cn("flex items-center gap-3 rounded-xl border bg-surface px-4 py-3 transition-colors duration-fast", current === s.id ? "border-accent" : "border-border-subtle hover:border-border")}>
                <button type="button" onClick={() => open(s)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-body font-medium text-fg">{s.name}</div>
                  <div className="text-caption text-fg-3">
                    {formatDate(s.started_at)} · {formatTime(s.started_at)} · {s.question_count} {s.question_count === 1 ? "question" : "questions"}
                    {current === s.id ? " · open now" : ""}
                  </div>
                </button>
                <Button size="sm" variant="secondary" onClick={() => open(s)}>
                  Open
                </Button>
                <Menu>
                  <MenuTrigger asChild>
                    <IconButton label={`More actions for ${s.name}`} size="sm" noTooltip>
                      <MoreHorizontal className="h-4 w-4" />
                    </IconButton>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onSelect={() => setRenaming(s)}>
                      Rename…
                    </MenuItem>
                    <MenuItem icon={<Download className="h-3.5 w-3.5" />} onSelect={() => void exportSession(s)}>
                      Save as a file…
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onSelect={() => setDeleting(s)}>
                      Delete…
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </li>
            ))}
          </ul>
        )}
      </div>
      <RenameDialog session={renaming} onClose={() => setRenaming(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this session?"
        description={deleting ? `“${deleting.name}” with its transcript, questions, screenshots and answers will be permanently deleted from this computer.` : ""}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.deleteSession(deleting.id);
            toast.success("Session deleted");
          } catch (err) {
            toast.error("Delete failed", errorMessage(err));
          }
        }}
      />
    </div>
  );
}

/** Save the session (transcript, questions, answers) as a Markdown file. */
async function exportSession(s: Session): Promise<void> {
  try {
    const body = await api.exportSession(s.id, "md");
    const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    const safe = s.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "session";
    const saved = await saveTextFile(`${safe}.md`, text);
    if (saved) toast.success("Saved", saved);
  } catch (err) {
    toast.error("Could not save the file", errorMessage(err));
  }
}

function RenameDialog({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [lastId, setLastId] = useState<string | null>(null);
  if (session && session.id !== lastId) {
    setLastId(session.id);
    setName(session.name);
  }
  const close = () => {
    setLastId(null);
    onClose();
  };
  const save = async () => {
    if (!session || !name.trim()) return;
    try {
      await api.updateSession(session.id, { name: name.trim() });
      toast.success("Renamed");
      close();
    } catch (err) {
      toast.error("Rename failed", errorMessage(err));
    }
  };
  return (
    <Modal
      open={!!session}
      onOpenChange={(o) => !o && close()}
      title="Rename session"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} aria-label="Session name" />
      </form>
    </Modal>
  );
}
