/** The resume and the job in the side panel: two cards, the resume file shown as uploaded, one resume at a time. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobInfo, ResumeInfo, ResumesState } from "@/types/engine";

const item = (id: string, label: string, extra: Partial<ResumeInfo> = {}): ResumeInfo => ({
  id,
  label,
  file_name: `${label}.pdf`,
  uploaded_at: Date.now() - 60_000,
  edited_at: null,
  can_revert: false,
  truncated: false,
  ocr: false,
  characters: 1200,
  words: 210,
  text: `${label}\nSenior Backend Engineer at Northwind Logistics.`,
  has_file: true,
  media_type: "application/pdf",
  profile: { state: "ready", text: "Asha Rao, Senior Backend Engineer.\nNorthwind Logistics: led the Kafka migration.", words: 10, model: "free-model" },
  ...extra,
});
const job: JobInfo = { title: "Staff Engineer, Payments", text: "Own the payments platform.", enabled: true, truncated: false, ocr: false, source: null, characters: 26, words: 4, updated_at: 1, brief: { state: "short", text: null, words: 0, model: null } };

let state: ResumesState;
const empty = (): ResumesState => ({ items: [], active_id: null, enabled: true, job: null, limits: { resume_chars: 24_000, job_chars: 12_000, resumes: 1 } });
const reply = (patch: Partial<ResumesState>) => {
  state = { ...state, ...patch };
  return state;
};
const api = {
  resumes: vi.fn(async () => state),
  uploadResume: vi.fn(async (_f: File) => state),
  selectResume: vi.fn(async (b: { active_id?: string; enabled?: boolean }) => reply({ ...(b.enabled !== undefined ? { enabled: b.enabled } : {}) })),
  resumeFile: vi.fn(async (_id: string) => new Blob(["%PDF-1.4"], { type: "application/pdf" })),
  condenseResume: vi.fn(async () => reply({ items: state.items.map((r) => ({ ...r, profile: { state: "making" as const, text: null, words: 0, model: null } })) })),
  openResumeFile: vi.fn(async (_id: string) => ({ ok: true })),
  deleteResume: vi.fn(async (_id: string) => reply({ items: [], active_id: null })),
  setJob: vi.fn(async (b: { title?: string | null; text: string }) => reply({ job: { ...job, title: b.title ?? "", text: b.text } })),
  uploadJob: vi.fn(async () => state),
  enableJob: vi.fn(async (enabled: boolean) => reply({ job: state.job ? { ...state.job, enabled } : null })),
  deleteJob: vi.fn(async () => reply({ job: null })),
};
// The factory is hoisted above the declarations: the getter looks `api` up when the panel calls it.
vi.mock("@/services/engine", () => ({
  get api() {
    return api;
  },
}));

import { useToasts } from "@/app/state/ui";
import { ResumeSection } from "@/features/sidepanel/ResumeSection";
import { TooltipProvider } from "@/components/primitives/Tooltip";

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ResumeSection />
      </TooltipProvider>
    </QueryClientProvider>,
  );
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

beforeEach(() => {
  state = empty();
  for (const f of Object.values(api)) f.mockClear();
  useToasts.setState({ toasts: [] });
  URL.createObjectURL = vi.fn(() => "blob:resume");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("the resume and the job", () => {
  it("are two cards side by side: upload a resume (one file), add the job", async () => {
    show();
    const resume = await screen.findByRole("button", { name: /Your resume/ });
    const jobCard = screen.getByRole("button", { name: /The job/ });
    expect(resume.parentElement).toBe(jobCard.parentElement);
    expect(resume.parentElement!.className).toContain("grid-cols-2");
    expect(fileInput().accept).toBe(".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp");
    expect(fileInput().multiple).toBe(false);
    expect(screen.queryByRole("button", { name: /View and edit/ })).toBeNull();
  });

  it("opens the resume file as it was uploaded, from its card; a PDF is shown as it is", async () => {
    state = { ...empty(), items: [item("rs_1", "Asha Rao CV")], active_id: "rs_1" };
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Open your resume: Asha Rao CV" }));
    const dialog = await screen.findByRole("dialog");
    const frame = (await within(dialog).findByTitle("Asha Rao CV.pdf (PDF)")) as HTMLIFrameElement;
    expect(frame.src).toBe("blob:resume");
    expect(api.resumeFile).toHaveBeenCalledWith("rs_1", expect.anything());
    expect(within(dialog).queryByRole("button", { name: /Add another|Save/ })).toBeNull(); // one resume, nothing to edit

    fireEvent.click(within(dialog).getByRole("button", { name: "Open in its app" }));
    await waitFor(() => expect(api.openResumeFile).toHaveBeenCalledWith("rs_1"));
  });

  it("shows a Word resume as the text read from it, with Open in Word", async () => {
    state = { ...empty(), items: [item("rs_1", "CV", { file_name: "CV.docx", media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })], active_id: "rs_1" };
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Open your resume/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Senior Backend Engineer at Northwind Logistics/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Open in Word" })).toBeTruthy();
    expect(api.resumeFile).not.toHaveBeenCalled(); // no layout in a browser: the text is what is shown
  });

  it("shows the text of a resume added before files were kept", async () => {
    state = { ...empty(), items: [item("rs_1", "Old CV", { has_file: false })], active_id: "rs_1" };
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Open your resume/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/added before ZHU kept the files themselves/)).toBeTruthy();
    expect(within(within(dialog).getByRole("region", { name: "Resume text" })).getByText(/Northwind Logistics/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Open in/ })).toBeNull();
  });

  it("shows a resume read from a picture right away, with the text read from it to check", async () => {
    show();
    await screen.findByRole("button", { name: /Your resume/ });
    api.resumeFile.mockImplementationOnce(async () => new Blob(["png"], { type: "image/png" }));
    api.uploadResume.mockImplementationOnce(async () => reply({ items: [item("rs_1", "Scan", { ocr: true, file_name: "scan.png", media_type: "image/png" })], active_id: "rs_1" }));
    fireEvent.change(fileInput(), { target: { files: [new File(["x"], "scan.png", { type: "image/png" })] } });
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("img", { name: "Scan, as uploaded" })).toBeTruthy();
    expect(within(dialog).getByText(/Windows text recognition/)).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "The text ZHU read from it" })).toBeTruthy();
    expect(useToasts.getState().toasts.at(-1)?.title).toBe("Resume added");
  });

  it("replaces the resume with a new upload, and removes it from the preview", async () => {
    state = { ...empty(), items: [item("rs_1", "Backend roles")], active_id: "rs_1" };
    show();
    await screen.findByRole("button", { name: /Open your resume/ });
    api.uploadResume.mockImplementationOnce(async () => reply({ items: [item("rs_2", "Platform roles")], active_id: "rs_2" }));
    fireEvent.change(fileInput(), { target: { files: [new File(["x"], "Platform roles.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByRole("button", { name: "Open your resume: Platform roles" })).toBeTruthy();
    expect(useToasts.getState().toasts.at(-1)?.title).toBe("Resume replaced");

    fireEvent.click(screen.getByRole("button", { name: "Open your resume: Platform roles" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove “Platform roles”?")).toBeTruthy();
    await act(async () => fireEvent.click(within(screen.getAllByRole("dialog").at(-1)!).getByRole("button", { name: "Remove" })));
    await waitFor(() => expect(api.deleteResume).toHaveBeenCalledWith("rs_2"));
    expect(await screen.findByRole("button", { name: /Your resume/ })).toBeTruthy();
  });

  it("says in plain words, with no accents or capitals, what the cards are", async () => {
    state = { ...empty(), items: [item("rs_1", "Backend roles")], active_id: "rs_1", job };
    const view = show();
    await screen.findByRole("button", { name: /Open your resume/ });
    expect(screen.getByText("Resume and job")).toBeTruthy();
    for (const caption of ["Resume", "Job"]) expect(screen.getByText(caption).className).not.toContain("uppercase");
    expect(view.container.textContent).not.toMatch(/résumé/i);
    expect(screen.getByText("PDF · Short profile ready")).toBeTruthy();
  });

  it("shows what AI models receive: the short profile made once, or the full text until then", async () => {
    state = { ...empty(), items: [item("rs_1", "Asha Rao CV")], active_id: "rs_1" };
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Open your resume/ }));
    const models = within(await screen.findByRole("dialog")).getByRole("region", { name: "What AI models receive" });
    expect(within(models).getByText(/Northwind Logistics: led the Kafka migration/)).toBeTruthy();
    expect(within(models).getByText(/made once from your file by free-model: 10 words instead of 210/)).toBeTruthy();
    cleanup();

    // It failed (a busy model): the full text goes, and it can be made again.
    state = { ...empty(), items: [item("rs_1", "Asha Rao CV", { profile: { state: "failed", text: null, words: 0, model: null } })], active_id: "rs_1" };
    show();
    expect(await screen.findByText("PDF · Full text for now")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open your resume/ }));
    const failed = within(await screen.findByRole("dialog")).getByRole("region", { name: "What AI models receive" });
    expect(within(failed).getByText(/Models get the full text for now/)).toBeTruthy();
    fireEvent.click(within(failed).getByRole("button", { name: "Make it again" }));
    await waitFor(() => expect(api.condenseResume).toHaveBeenCalledWith({ provider_id: null, model: null }));
    expect(await within(failed).findByText(/Making a short profile from it/)).toBeTruthy();
  });

  it("switches the resume off from its card without opening it", async () => {
    state = { ...empty(), items: [item("rs_1", "Backend roles")], active_id: "rs_1" };
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Use the resume in answers" }));
    await waitFor(() => expect(api.selectResume).toHaveBeenCalledWith({ enabled: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Not used")).toBeTruthy();
  });

  it("adds the job, opens it from its card, switches it off, and removes it", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: /The job/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Job title"), { target: { value: "  Staff Engineer, Payments " } });
    fireEvent.change(within(dialog).getByLabelText("Job description"), { target: { value: "Own the payments platform." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    // With the Custom chat's model, which condenses a long job description once.
    await waitFor(() => expect(api.setJob).toHaveBeenCalledWith({ title: "Staff Engineer, Payments", text: "Own the payments platform." }, { provider_id: null, model: null }));
    expect(await screen.findByText("Staff Engineer, Payments")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Use the job in answers" }));
    await waitFor(() => expect(api.enableJob).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "Open the job: Staff Engineer, Payments" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    await screen.findByText("Remove the job?");
    await act(async () => fireEvent.click(within(screen.getAllByRole("dialog").at(-1)!).getByRole("button", { name: "Remove" })));
    await waitFor(() => expect(api.deleteJob).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /The job/ })).toBeTruthy();
  });
});
