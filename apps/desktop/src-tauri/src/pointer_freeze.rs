//! Freezing the pointer over a hidden ZHU.
//!
//! A screen share or recording draws the real mouse pointer wherever it is, also over a window it
//! leaves out (bars.rs). So while ZHU is hidden, and the preference "Freeze the pointer while
//! hidden" is on, the real pointer stands still where it entered ZHU, and ZHU moves an arrow of
//! its own, which captures leave out like the rest of ZHU. Viewers see the pointer stop, and glide
//! on to where it leaves ZHU; you see an arrow move over ZHU, the title bar included. That arrow
//! is your own Windows arrow (your pointer scheme, at the size Windows shows it), not ZHU's violet
//! one: a hidden ZHU shows nothing of its own look.
//!
//! How:
//!   * A low-level mouse hook sees every mouse event before Windows acts on it. Over ZHU's page
//!     it swallows them: the real pointer does not move, and no other program gets the clicks. The
//!     movement Windows would have made (with your pointer speed and acceleration) moves ZHU's
//!     arrow instead. The hook has a thread of its own that does nothing else, so it always answers
//!     within Windows' time limit (Windows passes the mouse on past a hook that is too slow).
//!   * The stand-in, on a second thread, draws the arrow (a small click-through window left out of
//!     captures, showing the arrow cursor of your Windows pointer scheme) and hands
//!     every movement, click, double-click, wheel turn and drag to the window under the arrow, as
//!     the mouse would have. A click also brings ZHU to the front and gives the keyboard to the page
//!     under the arrow. Windows may refuse to bring a program forward that it did not see clicked
//!     (another program has the keyboard, often one running as administrator): then that press
//!     is made a real click at the arrow, which brings ZHU forward like any click, and the real
//!     pointer glides off the page again after it. Otherwise what you type would go to the other
//!     program. Dragging the title bar moves the window with the arrow (Windows' own drag
//!     follows the real pointer, which stands still).
//!   * What freezes is the whole page, and nothing of the window's edges: the strip along the top
//!     and the frame just outside the other edges, where Windows resizes the window, keep the real
//!     pointer. So when the arrow reaches an edge, the real pointer is on it and resizes as always.
//!   * When the arrow leaves the page with no button held, the real pointer glides from where it
//!     stood to the arrow (0.1 to 0.3 s, slow at the start and meeting the arrow at its own speed),
//!     then the mouse works as usual. A click or wheel turn on the way puts it there at once.
//!   * The real pointer never stands on the page itself (the page would get its movements too):
//!     if it is there (ZHU was hidden with it there, or the window was dragged over it), it glides
//!     to the nearest place just outside.
//!   * It lets go by itself when ZHU is shown again or the preference is switched off (gliding to
//!     the arrow), when ZHU's window is minimized, when another window covers ZHU under the arrow,
//!     when another program or a pen or touch screen moves the pointer, and when the stand-in has
//!     not answered for a second.
//!   * A touchpad's two-finger swipe goes to the window under the real pointer, which stands
//!     beside the page, and programs that scroll smoothly take it from the touchpad without the
//!     mouse hook seeing it. So while the page is frozen, a window of ZHU's of one pixel (the
//!     catcher, left out of captures and all but clear) stands under the real pointer: the swipe
//!     comes to it as wheel turns, and goes on to the page under the arrow.
//!
//! Limits: dragging files or text out of ZHU into another program needs the real pointer, and a
//! window dragged by its title bar does not snap to the screen's edges.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

static HIDDEN: AtomicBool = AtomicBool::new(false);
static PREFERENCE: AtomicBool = AtomicBool::new(true);
static APP: OnceLock<AppHandle> = OnceLock::new();
/// One change at a time: starting and stopping the two threads.
static CONTROL: Mutex<()> = Mutex::new(());

/// ZHU was hidden or shown again (bars.rs).
pub fn set_hidden(app: &AppHandle, hidden: bool) {
    let _ = APP.set(app.clone());
    HIDDEN.store(hidden, Ordering::SeqCst);
    update();
}

/// The preference "Freeze the pointer while hidden".
pub fn set_preference(app: &AppHandle, on: bool) {
    let _ = APP.set(app.clone());
    PREFERENCE.store(on, Ordering::SeqCst);
    update();
}

/// What the main window tells the freezing: where it is, and the start of a drag of its title bar.
/// Call once, on the main thread.
pub fn install(window: &tauri::WebviewWindow) {
    imp::install(window);
}

/// Starts or stops the two threads, on a thread of its own (it waits for them, and the caller may
/// be the window thread). Each run applies the state as it is then, so the last change wins
/// whatever order the runs happen in.
fn update() {
    std::thread::spawn(|| {
        let Ok(_one_at_a_time) = CONTROL.lock() else { return };
        let wanted = HIDDEN.load(Ordering::SeqCst) && PREFERENCE.load(Ordering::SeqCst);
        imp::set_wanted(wanted);
    });
}

fn log(message: &str) {
    if let Some(app) = APP.get() {
        crate::shell_log(app, "pointer", message);
    }
}

/// The decisions, without Windows: what to do with each mouse event. Kept apart so it can be tested.
pub(crate) mod machine {
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Pt {
        pub x: i32,
        pub y: i32,
    }

    /// Screen pixels; `right` and `bottom` are just outside.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    impl Rect {
        pub fn contains(&self, p: Pt) -> bool {
            p.x >= self.left && p.x < self.right && p.y >= self.top && p.y < self.bottom
        }
        pub fn clamp(&self, p: Pt) -> Pt {
            Pt { x: p.x.clamp(self.left, (self.right - 1).max(self.left)), y: p.y.clamp(self.top, (self.bottom - 1).max(self.top)) }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Button {
        Left,
        Right,
        Middle,
        X1,
        X2,
    }

    impl Button {
        pub const ALL: [Button; 5] = [Button::Left, Button::Right, Button::Middle, Button::X1, Button::X2];
        pub fn bit(self) -> u8 {
            1 << self.index()
        }
        pub fn index(self) -> usize {
            Self::ALL.iter().position(|b| *b == self).unwrap_or(0)
        }
        pub fn from_index(i: usize) -> Option<Button> {
            Self::ALL.get(i).copied()
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Event {
        /// Where Windows is about to put the pointer.
        Move(Pt),
        Down(Button),
        Up(Button),
        Wheel { delta: i16, horizontal: bool },
    }

    /// What is true at the moment of an event.
    #[derive(Clone, Copy, Debug)]
    pub struct Context {
        /// The stand-in is answering.
        pub active: bool,
        /// The part of ZHU's window that freezes the pointer, while ZHU is hidden and on screen.
        pub zone: Option<Rect>,
        /// Where the real pointer is now.
        pub cursor: Pt,
        /// All screens together.
        pub screen: Rect,
        /// Whether a point is on one of the screens (they need not fill `screen`).
        pub on_screen: fn(Pt) -> bool,
        /// The stand-in asked to let go (another window is in front of ZHU under the arrow).
        pub release: bool,
        /// Not the user's mouse: another program, a pen or a touch screen.
        pub foreign: bool,
        /// Windows is moving or resizing ZHU's window itself, with the real pointer.
        pub moving: bool,
        /// ZHU's window is the one in front: it has the keyboard.
        pub in_front: bool,
        /// Milliseconds, for the real pointer's glides.
        pub now: u64,
    }

    /// What the hook does with an event (or a tick of the clock).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Out {
        /// Windows handles the event as usual; otherwise nobody gets it.
        pub pass: bool,
        /// Put the real pointer here.
        pub cursor: Option<Pt>,
        /// What the stand-in is told.
        pub post: Post,
        /// Swallowed, and made again once the real pointer is where `cursor` says: Windows sends an
        /// event to the window under the pointer as it was when the event came.
        pub replay: bool,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Post {
        Nothing,
        /// ZHU's arrow is over the page, here (from now on, or again).
        Enter(Pt),
        Moved(Pt),
        Pressed(Button, Pt),
        Released(Button, Pt),
        Wheel { delta: i16, horizontal: bool, at: Pt },
        /// The arrow left the page (the page no longer has the mouse); it is still drawn, here.
        Away(Pt),
        /// Only draw the arrow here: the real pointer is on its way to it.
        Draw(Pt),
        /// The real pointer has the mouse again: the arrow goes.
        Leave(Pt),
    }

    impl Out {
        pub const PASS: Out = Out { pass: true, cursor: None, post: Post::Nothing, replay: false };
        pub const SWALLOW: Out = Out { pass: false, cursor: None, post: Post::Nothing, replay: false };
        fn post(post: Post) -> Out {
            Out { post, ..Out::SWALLOW }
        }
        fn put(cursor: Option<Pt>, post: Post) -> Out {
            Out { cursor, post, ..Out::SWALLOW }
        }
    }

    /// The real pointer moving by itself from where it stood.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Glide {
        from: Pt,
        start: u64,
        ms: u64,
    }

    impl Glide {
        /// None when the way is too short to be seen: the pointer goes there at once.
        fn new(from: Pt, to: Pt, now: u64) -> Option<Glide> {
            let ms = glide_ms(from, to);
            (ms > 0).then_some(Glide { from, start: now, ms })
        }

        /// Where the pointer is at `now` on its way to `to` (which may move meanwhile), and whether
        /// it is there. Slow at the start and at the end ("smoothstep"): it sets off from standing
        /// still like a hand would, and meets a moving arrow at the arrow's own speed, so the hand
        /// takes over without a jolt.
        fn at(&self, to: Pt, now: u64) -> (Pt, bool) {
            let t = (now.saturating_sub(self.start) as f64 / self.ms as f64).min(1.0);
            if t >= 1.0 {
                return (to, true);
            }
            let e = t * t * (3.0 - 2.0 * t);
            let along = |a: i32, b: i32| a + ((b - a) as f64 * e).round() as i32;
            (Pt { x: along(self.from.x, to.x), y: along(self.from.y, to.y) }, false)
        }
    }

    /// How long the real pointer takes over a distance: at once for a few pixels, then from a
    /// tenth of a second up to 0.3 s for the width of a screen.
    pub fn glide_ms(from: Pt, to: Pt) -> u64 {
        let d = (((to.x - from.x) as f64).powi(2) + ((to.y - from.y) as f64).powi(2)).sqrt();
        if d < 6.0 {
            0
        } else {
            (80.0 + 0.18 * d).clamp(100.0, 300.0) as u64
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum State {
        /// The real pointer has the mouse.
        Free,
        /// Over ZHU's page: the real pointer stands still outside it (or settles there), the arrow moves.
        Frozen { arrow: Pt, held: u8, settle: Option<(Glide, Pt)> },
        /// The arrow left the page: the real pointer glides to it, then has the mouse again.
        /// `forced`: asked to let go, so coming back over the page does not freeze it again.
        Leaving { arrow: Pt, glide: Glide, forced: bool },
    }

    #[derive(Debug)]
    pub struct Machine {
        state: State,
        /// Buttons pressed while the pointer was free: no freezing in the middle of a drag.
        real: u8,
        /// Buttons pressed in ZHU and still down when it let go: their release is ZHU's, not the program's below.
        stray: u8,
        /// Freezing may start with the pointer already over the page. Not after ZHU let go because
        /// another window covers the page there, until the pointer has been off the page.
        inside_ok: bool,
    }

    impl Default for Machine {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Machine {
        pub const fn new() -> Self {
            Machine { state: State::Free, real: 0, stray: 0, inside_ok: true }
        }

        pub fn is_free(&self) -> bool {
            self.state == State::Free
        }

        /// The arrow has the mouse over ZHU's page.
        pub fn is_frozen(&self) -> bool {
            matches!(self.state, State::Frozen { .. })
        }

        /// The real pointer is on its way somewhere: the hook needs a clock until it is there.
        pub fn gliding(&self) -> bool {
            matches!(self.state, State::Leaving { .. } | State::Frozen { settle: Some(_), .. })
        }

        pub fn step(&mut self, event: Event, ctx: &Context) -> Out {
            self.run(Some(event), ctx)
        }

        /// The clock, while the real pointer glides.
        pub fn tick(&mut self, ctx: &Context) -> Out {
            self.run(None, ctx)
        }

        /// Stopping at once: where to put the real pointer, if it was not free.
        pub fn let_go(&mut self) -> Option<Pt> {
            let (arrow, held) = match self.state {
                State::Free => return None,
                State::Frozen { arrow, held, .. } => (arrow, held),
                State::Leaving { arrow, .. } => (arrow, 0),
            };
            self.stray |= held;
            self.state = State::Free;
            Some(arrow)
        }

        fn run(&mut self, event: Option<Event>, ctx: &Context) -> Out {
            match self.state {
                State::Free => self.free(event, ctx),
                State::Frozen { arrow, held, settle } => self.frozen(event, ctx, arrow, held, settle),
                State::Leaving { arrow, glide, forced } => self.leaving(event, ctx, arrow, glide, forced),
            }
        }

        fn free(&mut self, event: Option<Event>, ctx: &Context) -> Out {
            match event {
                None | Some(Event::Wheel { .. }) => Out::PASS,
                Some(Event::Down(b)) => {
                    self.real |= b.bit();
                    Out::PASS
                }
                Some(Event::Up(b)) if self.stray & b.bit() != 0 => {
                    self.stray &= !b.bit();
                    Out::SWALLOW
                }
                Some(Event::Up(b)) => {
                    self.real &= !b.bit();
                    Out::PASS
                }
                Some(Event::Move(to)) => {
                    let Some(zone) = ctx.zone else {
                        self.inside_ok = true;
                        return Out::PASS;
                    };
                    let from_outside = !zone.contains(ctx.cursor);
                    if from_outside {
                        self.inside_ok = true;
                    }
                    if !ctx.active || ctx.foreign || ctx.moving || self.real != 0 || self.stray != 0 || !zone.contains(to) {
                        return Out::PASS;
                    }
                    if from_outside {
                        // Onto the page from outside it: the real pointer stands still where it was.
                        self.state = State::Frozen { arrow: to, held: 0, settle: None };
                        Out::post(Post::Enter(to))
                    } else if self.inside_ok {
                        // Already over the page (ZHU was hidden with the pointer there, or a drag
                        // ended there): the arrow takes over, and the real pointer moves off the page.
                        let mut settle = None;
                        let cursor = settle_step(&mut settle, zone, ctx);
                        self.state = State::Frozen { arrow: to, held: 0, settle };
                        Out::put(cursor, Post::Enter(to))
                    } else {
                        Out::PASS
                    }
                }
            }
        }

        fn frozen(&mut self, event: Option<Event>, ctx: &Context, mut arrow: Pt, mut held: u8, mut settle: Option<(Glide, Pt)>) -> Out {
            if !ctx.active || (ctx.foreign && !is_wheel(event)) {
                // At once: the stand-in cannot draw, or something else moves the pointer.
                self.keep_releases(held, event);
                return self.free_at(arrow);
            }
            if ctx.release {
                self.inside_ok = false;
                return self.leave(arrow, held, event, ctx, true);
            }
            let Some(zone) = ctx.zone else {
                // ZHU's window left the screen (minimized), or freezing is ending.
                return self.leave(arrow, held, event, ctx, true);
            };
            let mut out = match event {
                Some(Event::Move(to)) => {
                    arrow = moved(arrow, to, ctx);
                    // With a button held (a drag), the arrow may go past the edge and come back.
                    if held == 0 && !zone.contains(arrow) {
                        return self.leave(arrow, 0, None, ctx, false);
                    }
                    Out::post(Post::Moved(arrow))
                }
                // Another program has the keyboard, and Windows did not let ZHU come forward on
                // its own (the hook asked first): a press only ZHU hears of would leave the keyboard
                // there. This one is made a real click at the arrow, which brings ZHU forward like
                // any click; once it is released and the mouse moves on, the page freezes again.
                Some(Event::Down(b)) if held == 0 && !ctx.in_front => {
                    self.real |= b.bit();
                    return Out { replay: true, ..self.free_at(arrow) };
                }
                Some(Event::Down(b)) => {
                    held |= b.bit();
                    Out::post(Post::Pressed(b, arrow))
                }
                Some(Event::Up(b)) if held & b.bit() == 0 => Out::SWALLOW,
                Some(Event::Up(b)) => {
                    held &= !b.bit();
                    Out::post(Post::Released(b, arrow))
                }
                Some(Event::Wheel { delta, horizontal }) => Out::post(Post::Wheel { delta, horizontal, at: arrow }),
                // A drag that ended outside the page lets go once the clock ticks, or at the next movement.
                None if held == 0 && !zone.contains(arrow) => return self.leave(arrow, 0, None, ctx, false),
                None => Out::SWALLOW,
            };
            out.cursor = settle_step(&mut settle, zone, ctx);
            self.state = State::Frozen { arrow, held, settle };
            out
        }

        fn leaving(&mut self, event: Option<Event>, ctx: &Context, mut arrow: Pt, glide: Glide, forced: bool) -> Out {
            if !ctx.active || (ctx.foreign && !is_wheel(event)) {
                self.keep_releases(0, event);
                return self.free_at(arrow);
            }
            match event {
                Some(Event::Move(to)) => {
                    let before = arrow;
                    arrow = moved(arrow, to, ctx);
                    if let Some(zone) = ctx.zone.filter(|z| !forced && z.contains(arrow)) {
                        // Back over the page before the real pointer got to the arrow: it stops on
                        // its way, off the page (where the arrow left it, if it is on the page now).
                        let mut settle = None;
                        let mut cursor = None;
                        if zone.contains(ctx.cursor) {
                            match Glide::new(ctx.cursor, before, ctx.now) {
                                Some(g) => settle = Some((g, before)),
                                None => cursor = Some(before),
                            }
                        }
                        self.state = State::Frozen { arrow, held: 0, settle };
                        return Out::put(cursor, Post::Enter(arrow));
                    }
                    self.glide_on(arrow, glide, forced, ctx)
                }
                // A click or a wheel turn on the way: the pointer is at the arrow at once, and the
                // click goes there, to whatever is under the arrow (a press is a drag of the
                // program's from now on: no freezing until it is released).
                Some(Event::Down(b)) => {
                    self.real |= b.bit();
                    Out { replay: true, ..self.free_at(arrow) }
                }
                Some(Event::Wheel { .. }) => Out { replay: true, ..self.free_at(arrow) },
                Some(Event::Up(b)) if self.stray & b.bit() != 0 => {
                    self.stray &= !b.bit();
                    Out::SWALLOW
                }
                Some(Event::Up(b)) => {
                    self.real &= !b.bit();
                    Out::PASS
                }
                None => self.glide_on(arrow, glide, forced, ctx),
            }
        }

        /// The arrow left the page (or ZHU must let go): the real pointer glides to it.
        fn leave(&mut self, arrow: Pt, held: u8, event: Option<Event>, ctx: &Context, forced: bool) -> Out {
            self.keep_releases(held, event);
            match Glide::new(ctx.cursor, arrow, ctx.now) {
                Some(glide) => {
                    self.state = State::Leaving { arrow, glide, forced };
                    Out::post(Post::Away(arrow))
                }
                None => self.free_at(arrow),
            }
        }

        fn glide_on(&mut self, arrow: Pt, glide: Glide, forced: bool, ctx: &Context) -> Out {
            let (at, there) = glide.at(arrow, ctx.now);
            if there {
                return self.free_at(arrow);
            }
            self.state = State::Leaving { arrow, glide, forced };
            Out::put(Some(at), Post::Draw(arrow))
        }

        fn free_at(&mut self, arrow: Pt) -> Out {
            self.state = State::Free;
            Out::put(Some(arrow), Post::Leave(arrow))
        }

        /// Letting go with buttons pressed in ZHU (or this very event pressing one): their
        /// release must not reach the program below.
        fn keep_releases(&mut self, held: u8, event: Option<Event>) {
            self.stray |= held;
            match event {
                Some(Event::Up(b)) => self.stray &= !b.bit(),
                Some(Event::Down(b)) => self.stray |= b.bit(),
                _ => {}
            }
        }
    }

    /// A wheel turn moves no pointer, so one from elsewhere is no reason to let go: a touchpad's
    /// two-finger swipe can reach the hook as wheel turns Windows makes itself (marked as made by
    /// a program), and it is meant for the page under the arrow like the wheel's own.
    fn is_wheel(event: Option<Event>) -> bool {
        matches!(event, Some(Event::Wheel { .. }))
    }

    /// Windows would have moved the pointer from where it is to `to`: that movement, with the
    /// user's speed and acceleration, moves the arrow.
    fn moved(arrow: Pt, to: Pt, ctx: &Context) -> Pt {
        ctx.screen.clamp(Pt { x: arrow.x + to.x - ctx.cursor.x, y: arrow.y + to.y - ctx.cursor.y })
    }

    /// The real pointer never stands on the page: the page would get its movements as well as the
    /// arrow's. When it is there, it glides to the nearest place just outside. Returns where to put
    /// it now.
    fn settle_step(settle: &mut Option<(Glide, Pt)>, zone: Rect, ctx: &Context) -> Option<Pt> {
        if let Some((glide, to)) = *settle {
            let (at, there) = glide.at(to, ctx.now);
            if there {
                *settle = None;
            }
            return Some(at);
        }
        if !zone.contains(ctx.cursor) {
            return None;
        }
        let to = nearest_outside(zone, ctx.cursor, ctx.on_screen)?;
        match Glide::new(ctx.cursor, to, ctx.now) {
            Some(glide) => {
                *settle = Some((glide, to));
                None
            }
            None => Some(to),
        }
    }

    /// The nearest point just outside `zone` from `p` in it, on a screen.
    pub fn nearest_outside(zone: Rect, p: Pt, on_screen: fn(Pt) -> bool) -> Option<Pt> {
        [Pt { x: zone.left - 1, y: p.y }, Pt { x: zone.right, y: p.y }, Pt { x: p.x, y: zone.top - 1 }, Pt { x: p.x, y: zone.bottom }]
            .into_iter()
            .filter(|c| on_screen(*c))
            .min_by_key(|c| (c.x - p.x).abs() + (c.y - p.y).abs())
    }

    /// The part of ZHU's window that freezes the pointer: all of the page, title bar included, but
    /// not the strip along the top where Windows resizes the window (the other edges are resized
    /// from just outside the page). A maximized window has no such strip.
    pub fn frozen_zone(client: Rect, top_strip: i32, maximized: bool) -> Option<Rect> {
        let zone = Rect { top: client.top + if maximized { 0 } else { top_strip.max(0) }, ..client };
        (zone.left < zone.right && zone.top < zone.bottom).then_some(zone)
    }

    /// Whether a press makes a double-click with the one before it, by Windows' rules.
    pub fn is_double_click(previous: Option<(Button, u64, Pt)>, button: Button, at_ms: u64, at: Pt, max_ms: u64, width: i32, height: i32) -> bool {
        match previous {
            Some((b, ms, p)) => b == button && at_ms.saturating_sub(ms) <= max_ms && (at.x - p.x).abs() <= width / 2 && (at.y - p.y).abs() <= height / 2,
            None => false,
        }
    }

    /// The size Windows shows the pointer at on a screen: the pointer size chosen in Windows'
    /// settings (32 px unless made bigger), grown with the screen's scaling.
    pub fn cursor_px(base: u32, dpi: u32) -> i32 {
        let base = if base == 0 { 32 } else { base.min(256) };
        ((base * dpi.max(96)) as f64 / 96.0).round() as i32
    }

    /// A cursor's picture with its transparency, from two drawings of it: on black and on white
    /// (blue-green-red-alpha). Over black a pixel shows its colour times its opacity; over white
    /// that plus white times its transparency. So the difference is the transparency, and the
    /// drawing on black is already the colour multiplied by the opacity, as Windows wants it.
    /// Pixels that invert what is behind them (old black-and-white cursors) come out black.
    pub fn unblend(on_black: &[u8], on_white: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(on_black.len());
        for (b, w) in on_black.chunks_exact(4).zip(on_white.chunks_exact(4)) {
            let through = (0..3).map(|i| w[i] as i32 - b[i] as i32).max().unwrap_or(0);
            if through < 0 {
                out.extend_from_slice(&[0, 0, 0, 255]);
                continue;
            }
            let alpha = (255 - through).clamp(0, 255) as u8;
            out.extend_from_slice(&[b[0].min(alpha), b[1].min(alpha), b[2].min(alpha), alpha]);
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const ZONE: Rect = Rect { left: 100, top: 100, right: 500, bottom: 400 };
        const SCREEN: Rect = Rect { left: 0, top: 0, right: 1920, bottom: 1080 };

        fn on_screen(p: Pt) -> bool {
            SCREEN.contains(p)
        }
        fn at(cursor: Pt, now: u64) -> Context {
            Context { active: true, zone: Some(ZONE), cursor, screen: SCREEN, on_screen, release: false, foreign: false, moving: false, in_front: true, now }
        }
        fn ctx(cursor: Pt) -> Context {
            at(cursor, 0)
        }
        fn pt(x: i32, y: i32) -> Pt {
            Pt { x, y }
        }
        fn post(p: Post) -> Out {
            Out::put(None, p)
        }
        fn put(cursor: Pt, p: Post) -> Out {
            Out::put(Some(cursor), p)
        }

        /// Frozen at (90, 200) with the arrow at `arrow`.
        fn frozen_at(arrow: Pt) -> Machine {
            let mut m = Machine::new();
            assert_eq!(m.step(Event::Move(pt(105, 200)), &ctx(pt(90, 200))), post(Post::Enter(pt(105, 200))));
            m.step(Event::Move(pt(90 + arrow.x - 105, 200 + arrow.y - 200)), &ctx(pt(90, 200)));
            m
        }

        #[test]
        fn the_pointer_stands_still_where_it_entered_and_the_arrow_moves() {
            let mut m = Machine::new();
            assert_eq!(m.step(Event::Move(pt(90, 200)), &ctx(pt(80, 200))), Out::PASS);
            // Onto the page: the real pointer stays at (90, 200), where it was.
            assert_eq!(m.step(Event::Move(pt(105, 200)), &ctx(pt(90, 200))), post(Post::Enter(pt(105, 200))));
            // Windows would move it from (90, 200) by (+20, +5): the arrow moves by that.
            assert_eq!(m.step(Event::Move(pt(110, 205)), &ctx(pt(90, 200))), post(Post::Moved(pt(125, 205))));
            assert_eq!(m.step(Event::Move(pt(80, 200)), &ctx(pt(90, 200))), post(Post::Moved(pt(115, 205))));
            assert!(!m.is_free() && !m.gliding());
        }

        #[test]
        fn leaving_the_real_pointer_glides_to_the_arrow_and_meets_it() {
            let mut m = frozen_at(pt(480, 200));
            // Out to the right at t = 1000: the arrow is drawn there, the real pointer sets off.
            assert_eq!(m.step(Event::Move(pt(120, 200)), &at(pt(90, 200), 1000)), post(Post::Away(pt(510, 200))));
            assert!(m.gliding());
            let ms = glide_ms(pt(90, 200), pt(510, 200));
            assert!((100..=300).contains(&ms));
            // On the way: further along at every tick, slow at first.
            let mut last = 90;
            for t in [10, ms / 4, ms / 2, 3 * ms / 4] {
                let out = m.tick(&at(pt(last, 200), 1000 + t));
                assert_eq!(out.post, Post::Draw(pt(510, 200)));
                let x = out.cursor.unwrap().x;
                assert!(x > last && x < 510, "t {t}: {x} after {last}");
                last = x;
            }
            assert!(last > 400, "three quarters of the time is most of the way: {last}");
            // The hand keeps moving: the arrow moves on, and the pointer arrives exactly at it.
            let out = m.step(Event::Move(pt(last + 10, 200)), &at(pt(last, 200), 1000 + 7 * ms / 8));
            assert_eq!(out.post, Post::Draw(pt(520, 200)));
            assert_eq!(m.tick(&at(out.cursor.unwrap(), 1000 + ms)), put(pt(520, 200), Post::Leave(pt(520, 200))));
            assert!(m.is_free() && !m.gliding());
            assert_eq!(m.step(Event::Move(pt(530, 200)), &ctx(pt(520, 200))), Out::PASS);
        }

        #[test]
        fn a_short_way_out_is_at_once() {
            // The real pointer 1 px from where the arrow leaves: it is there at once.
            let mut near = Machine::new();
            near.step(Event::Move(pt(100, 200)), &ctx(pt(98, 200)));
            assert_eq!(near.step(Event::Move(pt(97, 200)), &ctx(pt(98, 200))), put(pt(99, 200), Post::Leave(pt(99, 200))));
            // 9 px away: a (short) glide.
            let mut m = frozen_at(pt(102, 200));
            assert_eq!(m.step(Event::Move(pt(87, 200)), &ctx(pt(90, 200))), post(Post::Away(pt(99, 200))));
        }

        #[test]
        fn a_click_or_a_wheel_turn_on_the_way_goes_where_the_arrow_is() {
            let mut m = frozen_at(pt(480, 200));
            m.step(Event::Move(pt(120, 200)), &at(pt(90, 200), 1000));
            m.tick(&at(pt(90, 200), 1050));
            let click = m.step(Event::Down(Button::Left), &at(pt(250, 200), 1060));
            assert_eq!(click, Out { replay: true, ..put(pt(510, 200), Post::Leave(pt(510, 200))) });
            // Made again there, the press reaches the program below as usual...
            assert_eq!(m.step(Event::Down(Button::Left), &ctx(pt(510, 200))), Out::PASS);
            // ...and a drag from there is the program's: no freezing until the button is up.
            assert_eq!(m.step(Event::Move(pt(450, 200)), &ctx(pt(510, 200))), Out::PASS);
            assert_eq!(m.step(Event::Up(Button::Left), &ctx(pt(450, 200))), Out::PASS);

            let mut m = frozen_at(pt(480, 200));
            m.step(Event::Move(pt(120, 200)), &at(pt(90, 200), 1000));
            let wheel = m.step(Event::Wheel { delta: 120, horizontal: false }, &at(pt(200, 200), 1040));
            assert_eq!(wheel, Out { replay: true, ..put(pt(510, 200), Post::Leave(pt(510, 200))) });
        }

        #[test]
        fn back_over_the_page_on_the_way_it_stops_off_the_page() {
            let mut m = frozen_at(pt(480, 200));
            m.step(Event::Move(pt(120, 200)), &at(pt(90, 200), 1000)); // the arrow left at (510, 200)
            let ms = glide_ms(pt(90, 200), pt(510, 200));
            let mid = m.tick(&at(pt(90, 200), 1000 + ms / 2)).cursor.unwrap();
            assert!(ZONE.contains(mid), "half way the real pointer is over the page: {mid:?}");
            // The arrow comes back: frozen again, and the real pointer goes on to where the arrow left.
            assert_eq!(m.step(Event::Move(pt(mid.x - 30, 200)), &at(mid, 1000 + ms / 2 + 5)), post(Post::Enter(pt(480, 200))));
            assert!(m.gliding());
            let to = glide_ms(mid, pt(510, 200));
            assert_eq!(m.tick(&at(mid, 1000 + ms / 2 + 5 + to)).cursor, Some(pt(510, 200)));
            assert!(!m.gliding());
            assert_eq!(m.step(Event::Move(pt(500, 200)), &ctx(pt(510, 200))), post(Post::Moved(pt(470, 200))));

            // Back while the real pointer is still off the page: it simply stops there.
            let mut m = frozen_at(pt(480, 200));
            m.step(Event::Move(pt(120, 200)), &at(pt(90, 200), 1000));
            let early = m.tick(&at(pt(90, 200), 1010)).cursor.unwrap();
            assert!(!ZONE.contains(early));
            assert_eq!(m.step(Event::Move(pt(early.x - 20, 200)), &at(early, 1012)), post(Post::Enter(pt(490, 200))));
            assert!(!m.gliding());
        }

        #[test]
        fn clicks_wheel_and_drags_go_to_the_arrow() {
            let mut m = Machine::new();
            m.step(Event::Move(pt(105, 200)), &ctx(pt(95, 200)));
            assert_eq!(m.step(Event::Down(Button::Left), &ctx(pt(95, 200))), post(Post::Pressed(Button::Left, pt(105, 200))));
            // A drag may leave the page while the button is held...
            assert_eq!(m.step(Event::Move(pt(0, 200)), &ctx(pt(95, 200))), post(Post::Moved(pt(10, 200))));
            assert_eq!(m.step(Event::Up(Button::Left), &ctx(pt(95, 200))), post(Post::Released(Button::Left, pt(10, 200))));
            // ...and lets go at the next movement once it is released outside.
            assert_eq!(m.step(Event::Move(pt(96, 200)), &at(pt(95, 200), 500)), post(Post::Away(pt(11, 200))));
            let mut m = Machine::new();
            m.step(Event::Move(pt(150, 150)), &ctx(pt(50, 150)));
            assert_eq!(m.step(Event::Wheel { delta: -120, horizontal: false }, &ctx(pt(50, 150))), post(Post::Wheel { delta: -120, horizontal: false, at: pt(150, 150) }));
        }

        #[test]
        fn a_wheel_turn_from_elsewhere_scrolls_the_page_and_keeps_it_frozen() {
            // A touchpad's two-finger swipe, as small wheel turns Windows makes itself.
            let mut m = frozen_at(pt(200, 200));
            let foreign = Context { foreign: true, ..ctx(pt(90, 200)) };
            assert_eq!(m.step(Event::Wheel { delta: -24, horizontal: false }, &foreign), post(Post::Wheel { delta: -24, horizontal: false, at: pt(200, 200) }));
            assert_eq!(m.step(Event::Wheel { delta: 16, horizontal: true }, &foreign), post(Post::Wheel { delta: 16, horizontal: true, at: pt(200, 200) }));
            assert!(m.is_frozen());
            // A movement from elsewhere still lets go at once.
            assert_eq!(m.step(Event::Move(pt(300, 300)), &foreign), put(pt(200, 200), Post::Leave(pt(200, 200))));

            // On the way out, it goes where the arrow is, like the wheel's own.
            let mut m = frozen_at(pt(480, 200));
            m.step(Event::Move(pt(120, 200)), &at(pt(90, 200), 1000));
            let wheel = m.step(Event::Wheel { delta: -24, horizontal: false }, &Context { foreign: true, ..at(pt(200, 200), 1040) });
            assert_eq!(wheel, Out { replay: true, ..put(pt(510, 200), Post::Leave(pt(510, 200))) });
        }

        #[test]
        fn a_click_into_zhu_while_another_program_has_the_keyboard_is_a_real_click_there() {
            let mut m = frozen_at(pt(200, 200));
            assert!(m.is_frozen());
            let behind = Context { in_front: false, ..ctx(pt(90, 200)) };
            // The real pointer goes to the arrow and the press is made again there: Windows then
            // brings ZHU forward, and what is typed next goes to ZHU.
            assert_eq!(m.step(Event::Down(Button::Left), &behind), Out { replay: true, ..put(pt(200, 200), Post::Leave(pt(200, 200))) });
            assert!(m.is_free());
            // Its release goes through as it is (no freezing while a button is down)...
            assert_eq!(m.step(Event::Up(Button::Left), &ctx(pt(200, 200))), Out::PASS);
            // ...and moving on freezes the page again, the real pointer leaving it.
            let out = m.step(Event::Move(pt(205, 200)), &ctx(pt(200, 200)));
            assert!(matches!(out.post, Post::Enter(_)) && m.is_frozen());
            // With ZHU in front, a press is ZHU's alone, as always.
            assert_eq!(m.step(Event::Down(Button::Left), &ctx(pt(200, 200))).post, Post::Pressed(Button::Left, pt(205, 200)));
        }

        #[test]
        fn no_freezing_during_a_drag_or_while_windows_moves_the_window() {
            let mut m = Machine::new();
            assert_eq!(m.step(Event::Down(Button::Left), &ctx(pt(50, 200))), Out::PASS);
            assert_eq!(m.step(Event::Move(pt(150, 200)), &ctx(pt(50, 200))), Out::PASS);
            assert_eq!(m.step(Event::Up(Button::Left), &ctx(pt(150, 200))), Out::PASS);
            let moving = Context { moving: true, ..ctx(pt(50, 200)) };
            assert_eq!(m.step(Event::Move(pt(150, 200)), &moving), Out::PASS);
            assert!(m.is_free());
        }

        #[test]
        fn already_over_the_page_it_freezes_and_the_real_pointer_moves_off_it() {
            // ZHU was hidden with the pointer at (300, 380), or a drag ended there.
            let mut m = Machine::new();
            assert_eq!(m.step(Event::Move(pt(305, 378)), &ctx(pt(300, 380))), post(Post::Enter(pt(305, 378))));
            assert!(m.gliding());
            // To the nearest place off the page: below it.
            let ms = glide_ms(pt(300, 380), pt(300, 400));
            assert_eq!(m.tick(&at(pt(300, 380), ms)).cursor, Some(pt(300, 400)));
            assert!(!m.gliding());
            assert_eq!(m.step(Event::Move(pt(310, 400)), &at(pt(300, 400), ms + 10)), post(Post::Moved(pt(315, 378))));
        }

        #[test]
        fn a_window_dragged_over_the_standing_pointer_moves_it_off_the_page() {
            let mut m = frozen_at(pt(150, 200));
            let moved = Rect { left: 60, ..ZONE }; // the page now covers (90, 200)
            let out = m.tick(&Context { zone: Some(moved), ..at(pt(90, 200), 0) });
            assert_eq!(out, Out::SWALLOW);
            assert!(m.gliding());
            let ms = glide_ms(pt(90, 200), pt(59, 200));
            assert_eq!(m.tick(&Context { zone: Some(moved), ..at(pt(90, 200), ms) }).cursor, Some(pt(59, 200)));
        }

        #[test]
        fn asked_to_let_go_it_glides_and_waits_until_the_pointer_was_off_the_page() {
            let mut m = frozen_at(pt(150, 150));
            let asked = Context { release: true, ..ctx(pt(90, 200)) };
            assert_eq!(m.step(Event::Move(pt(90, 200)), &asked), post(Post::Away(pt(150, 150))));
            // Over the page, but not freezing again on the way.
            let out = m.step(Event::Move(pt(95, 200)), &at(pt(90, 200), 50));
            assert_eq!(out.post, Post::Draw(pt(155, 150)));
            let ms = glide_ms(pt(90, 200), pt(155, 150));
            assert_eq!(m.tick(&at(out.cursor.unwrap(), ms)), put(pt(155, 150), Post::Leave(pt(155, 150))));
            // Free over the window in front of ZHU: stays free...
            assert_eq!(m.step(Event::Move(pt(160, 150)), &ctx(pt(155, 150))), Out::PASS);
            // ...until the pointer was off the page and comes back.
            assert_eq!(m.step(Event::Move(pt(90, 150)), &ctx(pt(160, 150))), Out::PASS);
            assert_eq!(m.step(Event::Move(pt(110, 150)), &ctx(pt(90, 150))), post(Post::Enter(pt(110, 150))));
        }

        #[test]
        fn it_lets_go_at_once_when_inactive_or_for_a_pen_and_keeps_the_release_of_a_held_button() {
            let mut m = Machine::new();
            m.step(Event::Move(pt(150, 150)), &ctx(pt(50, 150)));
            m.step(Event::Down(Button::Right), &ctx(pt(50, 150)));
            let off = Context { active: false, ..ctx(pt(50, 150)) };
            assert_eq!(m.step(Event::Move(pt(51, 150)), &off), put(pt(150, 150), Post::Leave(pt(150, 150))));
            // The right button was pressed in ZHU: its release must not reach the program below.
            assert_eq!(m.step(Event::Up(Button::Right), &off), Out::SWALLOW);
            assert_eq!(m.step(Event::Up(Button::Right), &off), Out::PASS);

            let mut m = Machine::new();
            m.step(Event::Move(pt(150, 150)), &ctx(pt(50, 150)));
            let pen = Context { foreign: true, ..ctx(pt(50, 150)) };
            assert_eq!(m.step(Event::Move(pt(300, 300)), &pen), put(pt(150, 150), Post::Leave(pt(150, 150))));
            assert_eq!(m.step(Event::Move(pt(160, 160)), &Context { cursor: pt(50, 150), ..pen }), Out::PASS); // not frozen by a pen either

            let mut m = Machine::new();
            m.step(Event::Move(pt(150, 150)), &ctx(pt(50, 150)));
            assert_eq!(m.let_go(), Some(pt(150, 150)));
            assert_eq!(m.let_go(), None);
        }

        #[test]
        fn minimized_or_stopping_it_glides_out_even_with_a_button_held() {
            let mut m = frozen_at(pt(150, 150));
            m.step(Event::Down(Button::Left), &ctx(pt(90, 200)));
            let gone = Context { zone: None, ..ctx(pt(90, 200)) };
            assert_eq!(m.tick(&gone), post(Post::Away(pt(150, 150))));
            // The left button was pressed in ZHU.
            assert_eq!(m.step(Event::Up(Button::Left), &gone), Out::SWALLOW);
            let ms = glide_ms(pt(90, 200), pt(150, 150));
            assert_eq!(m.tick(&Context { now: ms, ..gone }), put(pt(150, 150), Post::Leave(pt(150, 150))));
        }

        #[test]
        fn nothing_freezes_while_inactive_or_with_zhu_off_screen() {
            let mut m = Machine::new();
            assert_eq!(m.step(Event::Move(pt(150, 150)), &Context { active: false, ..ctx(pt(50, 150)) }), Out::PASS);
            assert_eq!(m.step(Event::Move(pt(150, 150)), &Context { zone: None, ..ctx(pt(50, 150)) }), Out::PASS);
            assert!(m.is_free());
        }

        #[test]
        fn the_arrow_stays_on_the_screens() {
            let mut m = Machine::new();
            let wide = Context { zone: Some(Rect { left: 0, top: 0, right: 1920, bottom: 1080 }), ..ctx(pt(5, 5)) };
            m.step(Event::Move(pt(10, 10)), &Context { cursor: pt(-1, -1), ..wide });
            assert_eq!(m.step(Event::Move(pt(-500, -500)), &Context { cursor: pt(-1, -1), ..wide }), post(Post::Moved(pt(0, 0))));
        }

        #[test]
        fn the_frozen_part_is_the_page_without_the_top_resize_strip() {
            // Measured on ZHU at 125 %: page 244..1844 x 145..1145, the strip 5 px.
            let client = Rect { left: 244, top: 145, right: 1844, bottom: 1145 };
            assert_eq!(frozen_zone(client, 5, false), Some(Rect { left: 244, top: 150, right: 1844, bottom: 1145 }));
            assert_eq!(frozen_zone(client, 5, true), Some(client));
            assert_eq!(frozen_zone(Rect { left: 0, top: 0, right: 10, bottom: 4 }, 5, false), None);
        }

        #[test]
        fn the_nearest_place_off_the_page_is_on_a_screen() {
            assert_eq!(nearest_outside(ZONE, pt(110, 300), on_screen), Some(pt(99, 300)));
            assert_eq!(nearest_outside(ZONE, pt(300, 395), on_screen), Some(pt(300, 400)));
            // A page against the left of the screen: not off the screen.
            let left = Rect { left: 0, ..ZONE };
            assert_eq!(nearest_outside(left, pt(10, 300), on_screen), Some(pt(10, 400)));
        }

        #[test]
        fn glides_take_longer_for_longer_ways() {
            assert_eq!(glide_ms(pt(0, 0), pt(3, 4)), 0);
            assert_eq!(glide_ms(pt(0, 0), pt(100, 0)), 100);
            assert_eq!(glide_ms(pt(0, 0), pt(1000, 0)), 260);
            assert_eq!(glide_ms(pt(0, 0), pt(3000, 0)), 300);
        }

        #[test]
        fn double_clicks_follow_the_windows_rules() {
            let first = Some((Button::Left, 1000, pt(100, 100)));
            assert!(is_double_click(first, Button::Left, 1300, pt(101, 102), 500, 4, 4));
            assert!(!is_double_click(first, Button::Left, 1600, pt(100, 100), 500, 4, 4)); // too late
            assert!(!is_double_click(first, Button::Left, 1100, pt(110, 100), 500, 4, 4)); // too far
            assert!(!is_double_click(first, Button::Right, 1100, pt(100, 100), 500, 4, 4));
            assert!(!is_double_click(None, Button::Left, 1100, pt(100, 100), 500, 4, 4));
        }

        #[test]
        fn the_arrow_is_as_big_as_windows_shows_the_pointer() {
            assert_eq!(cursor_px(32, 96), 32);
            assert_eq!(cursor_px(32, 120), 40); // 125 %
            assert_eq!(cursor_px(32, 144), 48);
            assert_eq!(cursor_px(48, 120), 60); // a bigger pointer chosen in Windows' settings
            assert_eq!(cursor_px(0, 96), 32); // the setting missing
        }

        #[test]
        fn the_arrows_transparency_comes_from_two_drawings() {
            // Opaque white, opaque black, half-transparent grey, see-through, an inverting pixel.
            let on_black = [255, 255, 255, 0, 0, 0, 0, 0, 64, 64, 64, 0, 0, 0, 0, 0, 255, 255, 255, 0];
            let on_white = [255, 255, 255, 0, 0, 0, 0, 0, 191, 191, 191, 0, 255, 255, 255, 0, 0, 0, 0, 0];
            assert_eq!(
                unblend(&on_black, &on_white),
                vec![255, 255, 255, 255, 0, 0, 0, 255, 64, 64, 64, 128, 0, 0, 0, 0, 0, 0, 0, 255]
            );
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use tauri::Manager;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, MonitorFromPoint, ReleaseDC, ScreenToClient, SelectObject, AC_SRC_ALPHA, AC_SRC_OVER,
        GdiFlush, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
    };
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, GetSystemMetricsForDpi, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetDoubleClickTime, SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
        MOUSE_EVENT_FLAGS, VK_CONTROL, VK_SHIFT,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::*;

    use super::machine::{self, Button, Context, Event, Machine, Out, Post, Pt, Rect};

    /// Messages from the hook (and the main window) to the stand-in.
    const MSG_ENTER: u32 = WM_APP + 1;
    const MSG_MOVE: u32 = WM_APP + 2;
    const MSG_PRESS: u32 = WM_APP + 3;
    const MSG_RELEASE: u32 = WM_APP + 4;
    const MSG_WHEEL: u32 = WM_APP + 5;
    const MSG_LEAVE: u32 = WM_APP + 6;
    const MSG_AWAY: u32 = WM_APP + 7;
    const MSG_DRAW: u32 = WM_APP + 8;
    /// The page started a drag of the window by its title bar.
    const MSG_DRAG_WINDOW: u32 = WM_APP + 9;
    /// To the hook's thread: freezing ends (the real pointer glides to the arrow first).
    const MSG_STOP: u32 = WM_APP + 20;
    /// To the hook's thread: make the held-back press or wheel turn again (see `Out::replay`).
    const MSG_REPLAY: u32 = WM_APP + 21;

    /// Freezing is wanted (hidden and the preference on).
    static WANTED: AtomicBool = AtomicBool::new(false);
    /// The stand-in's window (the arrow), 0 while it is not running.
    static STAND_IN: AtomicIsize = AtomicIsize::new(0);
    /// The hook's thread, 0 while it is not running.
    static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
    static HOOK_JOIN: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
    /// ZHU's main window.
    static MAIN: AtomicIsize = AtomicIsize::new(0);
    /// The frozen part of the main window, kept up to date by the main window and the stand-in.
    static ZONE: Mutex<Option<Rect>> = Mutex::new(None);
    /// Windows is moving or resizing the main window in its own loop.
    static MOVING: AtomicBool = AtomicBool::new(false);
    /// The stand-in holds the left button down on ZHU's page (a title-bar drag may follow).
    static LEFT_IN_ZHU: AtomicBool = AtomicBool::new(false);
    /// When the stand-in last ran (ms since START): the hook lets go if it stops answering.
    static BEAT: AtomicU64 = AtomicU64::new(0);
    static RELEASE: AtomicBool = AtomicBool::new(false);
    static MACHINE: Mutex<Machine> = Mutex::new(Machine::new());
    static START: OnceLock<Instant> = OnceLock::new();
    /// Test harness only (debug builds, ZHU_FREEZE_TEST=1 or =visible): input from SendInput counts as the mouse's.
    static ACCEPT_INJECTED: AtomicBool = AtomicBool::new(false);
    /// A press or wheel turn held back to be made again at the arrow, on the hook's thread.
    static REPLAY: Mutex<Option<Replay>> = Mutex::new(None);
    /// Wheel turns over the frozen page since freezing started, by the way they came: through the
    /// hook from the mouse, through the hook made by Windows or a program, and to the catcher
    /// (a touchpad's swipe). Logged when freezing ends.
    static WHEELS: [AtomicU32; 3] = [AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)];
    /// The pointer's shape when the catcher went under it, which it keeps (0: the arrow).
    static CATCHER_CURSOR: AtomicIsize = AtomicIsize::new(0);
    const WHEEL_MOUSE: usize = 0;
    const WHEEL_MADE: usize = 1;
    const WHEEL_CAUGHT: usize = 2;

    #[derive(Clone, Copy)]
    struct Replay {
        /// The mouse message and its data, as the hook got them.
        message: u32,
        data: u32,
        at: Pt,
        /// The button was released before the press was made again: the release follows it.
        released: bool,
    }
    const STAND_IN_PATIENCE_MS: u64 = 1000;
    /// Showing ZHU again waits this long at most for the real pointer to reach the arrow.
    const STOP_GLIDE_MS: u64 = 600;
    /// The clock of a glide (Windows rounds it to its timer, about 16 ms).
    const GLIDE_TICK_MS: u32 = 10;
    /// Any number that no other subclass of the main window uses ("ZHU" + 4; resize_cursor.rs has
    /// + 1, bars.rs + 2, opacity.rs + 3).
    const SUBCLASS_ID: usize = 0x5A48_5504;

    fn now_ms() -> u64 {
        START.get_or_init(Instant::now).elapsed().as_millis() as u64
    }

    pub fn set_wanted(wanted: bool) {
        WANTED.store(wanted, Ordering::SeqCst);
        if wanted {
            start();
        } else {
            stop();
        }
    }

    fn start() {
        #[cfg(debug_assertions)]
        ACCEPT_INJECTED.store(matches!(std::env::var("ZHU_FREEZE_TEST").as_deref(), Ok("1" | "visible")), Ordering::SeqCst);
        if let Some(main) = super::APP.get().and_then(crate::main_window).and_then(|w| w.hwnd().ok()) {
            MAIN.store(main.0 as isize, Ordering::SeqCst);
        }
        if STAND_IN.load(Ordering::SeqCst) == 0 {
            let (tx, rx) = mpsc::channel();
            let _ = std::thread::Builder::new().name("zhu-pointer-stand-in".into()).spawn(move || stand_in_thread(tx));
            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok(true) => {}
                _ => {
                    super::log("the stand-in arrow could not be made; the pointer is not frozen");
                    return;
                }
            }
        }
        if HOOK_THREAD.load(Ordering::SeqCst) == 0 {
            let (tx, rx) = mpsc::channel();
            let handle = std::thread::Builder::new().name("zhu-pointer-hook".into()).spawn(move || hook_thread(tx));
            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok(true) => {
                    if let (Ok(handle), Ok(mut join)) = (handle, HOOK_JOIN.lock()) {
                        *join = Some(handle);
                    }
                    for count in &WHEELS {
                        count.store(0, Ordering::Relaxed);
                    }
                    super::log("frozen over ZHU while it is hidden");
                }
                _ => super::log("the mouse hook could not be installed; the pointer is not frozen"),
            }
        }
    }

    fn stop() {
        // Nothing freezes any more: the hook glides the real pointer to the arrow, then ends.
        set_zone(None);
        let hook = HOOK_THREAD.load(Ordering::SeqCst);
        if hook != 0 {
            unsafe {
                if PostThreadMessageW(hook, MSG_STOP, WPARAM(0), LPARAM(0)).is_err() {
                    let _ = PostThreadMessageW(hook, WM_QUIT, WPARAM(0), LPARAM(0));
                }
            }
            if let Some(handle) = HOOK_JOIN.lock().ok().and_then(|mut j| j.take()) {
                let _ = handle.join();
            }
            HOOK_THREAD.store(0, Ordering::SeqCst);
            let [mouse, made, caught] = WHEELS.each_ref().map(|c| c.swap(0, Ordering::Relaxed));
            if mouse + made + caught > 0 {
                super::log(&format!("wheel turns over the page while frozen: {mouse} from the mouse, {made} made by Windows or a program, {caught} through the catcher (touchpad)"));
            }
            super::log("free again");
        }
        let stand_in = STAND_IN.load(Ordering::SeqCst);
        if stand_in != 0 {
            unsafe {
                let _ = PostMessageW(Some(HWND(stand_in as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }

    // ------------------------------------------------------------------ the main window

    pub fn install(window: &tauri::WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        MAIN.store(hwnd.0 as isize, Ordering::SeqCst);
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(main_subclass), SUBCLASS_ID, 0);
        }
    }

    /// The main window's procedure hook, on the main thread. It must never panic.
    unsafe extern "system" fn main_subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        match msg {
            // The title bar was pressed on the page (Tauri's drag region asks Windows to drag the
            // window). Windows' drag follows the real pointer, which stands still: while the arrow
            // holds the button, the stand-in moves the window with the arrow instead.
            WM_NCLBUTTONDOWN if wparam.0 == HTCAPTION as usize && LEFT_IN_ZHU.load(Ordering::SeqCst) => {
                let stand_in = STAND_IN.load(Ordering::SeqCst);
                if stand_in != 0 {
                    unsafe {
                        let _ = PostMessageW(Some(HWND(stand_in as _)), MSG_DRAG_WINDOW, WPARAM(0), LPARAM(0));
                    }
                    return LRESULT(0);
                }
            }
            WM_ENTERSIZEMOVE => MOVING.store(true, Ordering::SeqCst),
            WM_EXITSIZEMOVE => MOVING.store(false, Ordering::SeqCst),
            // Moved, resized, maximized, shown or hidden: the frozen part moves with it at once.
            WM_WINDOWPOSCHANGED if WANTED.load(Ordering::SeqCst) => set_zone(page_zone()),
            WM_NCDESTROY => unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(main_subclass), SUBCLASS_ID);
            },
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    fn set_zone(zone: Option<Rect>) {
        if let Ok(mut z) = ZONE.lock() {
            *z = zone;
        }
    }

    /// The page of the main window without the strip along its top where Windows resizes it
    /// (Tauri's frameless window answers "top edge" there; the other edges are resized from the
    /// frame just outside the page). Only while freezing is wanted and the window is on screen.
    fn page_zone() -> Option<Rect> {
        let main = main_window();
        if !WANTED.load(Ordering::SeqCst) || main.is_invalid() || unsafe { !IsWindowVisible(main).as_bool() || IsIconic(main).as_bool() } {
            return None;
        }
        let mut client = RECT::default();
        let mut origin = POINT::default();
        unsafe {
            GetClientRect(main, &mut client).ok()?;
            if !ClientToScreen(main, &mut origin).as_bool() {
                return None;
            }
            let dpi = GetDpiForWindow(main).max(96);
            let strip = GetSystemMetricsForDpi(SM_CYFRAME, dpi);
            let page = Rect { left: origin.x, top: origin.y, right: origin.x + client.right, bottom: origin.y + client.bottom };
            machine::frozen_zone(page, strip, IsZoomed(main).as_bool())
        }
    }

    // ------------------------------------------------------------------ the hook

    thread_local! {
        /// The glide clock on the hook's thread (0: not running).
        static TIMER: Cell<usize> = const { Cell::new(0) };
    }

    fn hook_thread(ready: mpsc::Sender<bool>) {
        unsafe {
            // A message queue before anyone posts to this thread.
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
            if let Ok(mut m) = MACHINE.lock() {
                *m = Machine::new();
            }
            let module = GetModuleHandleW(None).ok();
            let Ok(hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), module.map(|m| m.into()), 0) else {
                let _ = ready.send(false);
                return;
            };
            HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            let _ = ready.send(true);
            let mut stop_by = None;
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                match msg.message {
                    WM_TIMER => tick(),
                    MSG_STOP => {
                        stop_by = Some(now_ms() + STOP_GLIDE_MS);
                        tick();
                    }
                    MSG_REPLAY => {
                        if let Some(r) = REPLAY.lock().ok().and_then(|mut r| r.take()) {
                            replay(r);
                        }
                    }
                    _ => {}
                }
                if let Some(by) = stop_by {
                    let free = MACHINE.lock().map(|m| m.is_free()).unwrap_or(true);
                    if free || now_ms() >= by {
                        break;
                    }
                }
            }
            // Ending: whatever is left, at once.
            let at = MACHINE.lock().ok().and_then(|mut m| m.let_go());
            if let Some(at) = at {
                let _ = SetCursorPos(at.x, at.y);
                post(MSG_LEAVE, 0, at);
            }
            sync_timer(false);
            let _ = UnhookWindowsHookEx(hook);
        }
    }

    /// Called by Windows for every mouse event, on the hook's thread. Must be quick and never panic.
    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            if handle(wparam.0 as u32, info) {
                return LRESULT(1);
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// True when the event is swallowed.
    fn handle(message: u32, info: &MSLLHOOKSTRUCT) -> bool {
        let pt = Pt { x: info.pt.x, y: info.pt.y };
        let x_button = || if (info.mouseData >> 16) as u16 == XBUTTON2 { Button::X2 } else { Button::X1 };
        let event = match message {
            WM_MOUSEMOVE => Event::Move(pt),
            WM_LBUTTONDOWN => Event::Down(Button::Left),
            WM_LBUTTONUP => Event::Up(Button::Left),
            WM_RBUTTONDOWN => Event::Down(Button::Right),
            WM_RBUTTONUP => Event::Up(Button::Right),
            WM_MBUTTONDOWN => Event::Down(Button::Middle),
            WM_MBUTTONUP => Event::Up(Button::Middle),
            WM_XBUTTONDOWN => Event::Down(x_button()),
            WM_XBUTTONUP => Event::Up(x_button()),
            WM_MOUSEWHEEL => Event::Wheel { delta: (info.mouseData >> 16) as i16, horizontal: false },
            WM_MOUSEHWHEEL => Event::Wheel { delta: (info.mouseData >> 16) as i16, horizontal: true },
            _ => return false,
        };
        let injected = info.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED) != 0;
        // Pen and touch input carry this signature (Windows' "MI_WP_SIGNATURE").
        let touch = (info.dwExtraInfo as u32) & 0xFFFF_FF00 == 0xFF51_5700;
        let foreign = (injected && !ACCEPT_INJECTED.load(Ordering::Relaxed)) || touch;
        if let Event::Up(b) = event {
            // Released before its held-back press was made again: it follows that press.
            if let Some(r) = REPLAY.lock().ok().as_mut().and_then(|r| r.as_mut()) {
                if replay_button(r.message) == Some(b) {
                    r.released = true;
                    return true;
                }
            }
        }
        let out = {
            let Ok(mut machine) = MACHINE.lock() else { return false };
            if matches!(event, Event::Wheel { .. }) && machine.is_frozen() {
                WHEELS[if injected || touch { WHEEL_MADE } else { WHEEL_MOUSE }].fetch_add(1, Ordering::Relaxed);
            }
            if matches!(event, Event::Down(_)) && !foreign && machine.is_frozen() && !in_front() {
                // A click into ZHU while another program has the keyboard. Windows lets a program
                // come forward while it handles the user's own input, which this hook is doing; if
                // it still refuses, the machine makes the click a real one (Machine::frozen).
                unsafe {
                    let _ = SetForegroundWindow(main_window());
                }
            }
            let out = machine.step(event, &context(foreign));
            match (out.replay, out.cursor) {
                (true, Some(at)) => {
                    // Not from inside the hook: Windows would start a drag made from it (of a
                    // window's edge, say) at the place of the event in hand. Right after it,
                    // from this thread, as a movement to the arrow and the press there.
                    if let Ok(mut r) = REPLAY.lock() {
                        *r = Some(Replay { message, data: info.mouseData, at, released: false });
                    }
                    unsafe {
                        let _ = PostThreadMessageW(GetCurrentThreadId(), MSG_REPLAY, WPARAM(0), LPARAM(0));
                    }
                    apply(Out { cursor: None, ..out });
                }
                _ => apply(out),
            }
            sync_timer(machine.gliding());
            out
        };
        !out.pass
    }

    /// The button a held-back press is of.
    fn replay_button(message: u32) -> Option<Button> {
        match message {
            WM_LBUTTONDOWN => Some(Button::Left),
            WM_RBUTTONDOWN => Some(Button::Right),
            WM_MBUTTONDOWN => Some(Button::Middle),
            WM_XBUTTONDOWN => None, // which one is in the data; its release is not held back
            _ => None,
        }
    }

    /// Makes a held-back press or wheel turn again: a movement to the arrow, then the press (and
    /// its release, if the button is up already). It goes round through the hook like the
    /// mouse's own. The hook gets the buttons as the program sees them; input made here is the
    /// mouse's own, so swapped buttons are swapped back.
    fn replay(r: Replay) {
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        let (left, right) = if swapped { ((MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP), (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)) } else { ((MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP), (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)) };
        let high = r.data >> 16;
        let ((down, up), data) = match r.message {
            WM_LBUTTONDOWN => (left, 0),
            WM_RBUTTONDOWN => (right, 0),
            WM_MBUTTONDOWN => ((MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP), 0),
            WM_XBUTTONDOWN => ((MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP), high),
            // The wheel's turn is a signed number.
            WM_MOUSEWHEEL => ((MOUSEEVENTF_WHEEL, MOUSE_EVENT_FLAGS(0)), high as u16 as i16 as i32 as u32),
            WM_MOUSEHWHEEL => ((MOUSEEVENTF_HWHEEL, MOUSE_EVENT_FLAGS(0)), high as u16 as i16 as i32 as u32),
            _ => return,
        };
        // Absolute places run from 0 to 65535 across all the screens.
        let s = screens();
        let scale = |v: i32, from: i32, size: i32| (((v - from) as f64) * 65535.0 / ((size - 1).max(1) as f64)).round() as i32;
        let (dx, dy) = (scale(r.at.x, s.left, s.right - s.left), scale(r.at.y, s.top, s.bottom - s.top));
        let mouse = |dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS, data: u32| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        };
        let mut inputs = vec![mouse(dx, dy, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0), mouse(0, 0, down, data)];
        if r.released && up.0 != 0 {
            inputs.push(mouse(0, 0, up, data));
        }
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    /// The glide clock ticked (or freezing is ending).
    fn tick() {
        let Ok(mut machine) = MACHINE.lock() else { return };
        let out = machine.tick(&context(false));
        apply(out);
        sync_timer(machine.gliding());
    }

    fn context(foreign: bool) -> Context {
        Context {
            active: active(),
            zone: ZONE.lock().map(|z| *z).unwrap_or(None),
            cursor: cursor(),
            screen: screens(),
            on_screen,
            release: RELEASE.swap(false, Ordering::SeqCst),
            foreign,
            moving: MOVING.load(Ordering::SeqCst),
            in_front: in_front(),
            now: now_ms(),
        }
    }

    /// ZHU's main window is the one in front (it, or one of its pages, has the keyboard).
    fn in_front() -> bool {
        unsafe {
            let front = GetForegroundWindow();
            !front.is_invalid() && (front == main_window() || GetAncestor(front, GA_ROOT) == main_window())
        }
    }

    fn apply(out: Out) {
        if let Some(at) = out.cursor {
            unsafe {
                let _ = SetCursorPos(at.x, at.y);
            }
        }
        match out.post {
            Post::Nothing => {}
            Post::Enter(at) => post(MSG_ENTER, 0, at),
            Post::Moved(at) => post(MSG_MOVE, 0, at),
            Post::Pressed(b, at) => post(MSG_PRESS, b.index(), at),
            Post::Released(b, at) => post(MSG_RELEASE, b.index(), at),
            Post::Wheel { delta, horizontal, at } => post(MSG_WHEEL, (delta as u16 as usize) | ((horizontal as usize) << 16), at),
            Post::Away(at) => post(MSG_AWAY, 0, at),
            Post::Draw(at) => post(MSG_DRAW, 0, at),
            Post::Leave(at) => post(MSG_LEAVE, 0, at),
        }
    }

    /// Runs the glide clock on the hook's thread while the real pointer is on its way.
    fn sync_timer(gliding: bool) {
        TIMER.with(|timer| unsafe {
            if gliding && timer.get() == 0 {
                timer.set(SetTimer(None, 0, GLIDE_TICK_MS, None));
            } else if !gliding && timer.get() != 0 {
                let _ = KillTimer(None, timer.get());
                timer.set(0);
            }
        });
    }

    /// The stand-in is running and answering (it ends after the hook, when freezing stops).
    fn active() -> bool {
        STAND_IN.load(Ordering::SeqCst) != 0 && now_ms().saturating_sub(BEAT.load(Ordering::SeqCst)) < STAND_IN_PATIENCE_MS
    }

    fn cursor() -> Pt {
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        Pt { x: p.x, y: p.y }
    }

    fn screens() -> Rect {
        unsafe {
            let (x, y) = (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN));
            Rect { left: x, top: y, right: x + GetSystemMetrics(SM_CXVIRTUALSCREEN), bottom: y + GetSystemMetrics(SM_CYVIRTUALSCREEN) }
        }
    }

    fn on_screen(p: Pt) -> bool {
        unsafe { !MonitorFromPoint(POINT { x: p.x, y: p.y }, MONITOR_DEFAULTTONULL).is_invalid() }
    }

    /// Hands something to the stand-in.
    fn post(message: u32, wparam: usize, at: Pt) {
        let stand_in = STAND_IN.load(Ordering::SeqCst);
        if stand_in != 0 {
            unsafe {
                let _ = PostMessageW(Some(HWND(stand_in as _)), message, WPARAM(wparam), LPARAM(pack(at)));
            }
        }
    }

    fn pack(p: Pt) -> isize {
        ((p.x as u32 as u64) | ((p.y as u32 as u64) << 32)) as isize
    }

    fn unpack(v: isize) -> Pt {
        let v = v as u64;
        Pt { x: v as u32 as i32, y: (v >> 32) as u32 as i32 }
    }

    // ------------------------------------------------------------------ the stand-in

    /// The arrow as drawn for one screen scaling: blue-green-red-alpha, colours multiplied by the
    /// opacity, and where its tip (the pointer's position) is in it.
    struct ArrowImage {
        pixels: Vec<u8>,
        size: i32,
        hot_x: i32,
        hot_y: i32,
    }

    #[derive(Default)]
    struct StandIn {
        /// The scaling (dpi) of the image shown, None while the arrow is hidden.
        image: Option<u32>,
        /// The arrow, made once per screen scaling.
        arrows: std::collections::HashMap<u32, Option<ArrowImage>>,
        /// Where the arrow is.
        at: Pt,
        /// The window that last got a movement, and the one that got the press of the buttons now held.
        hover: Option<isize>,
        capture: Option<isize>,
        held: u8,
        last_press: Option<(Button, u64, Pt)>,
        /// Where the left button went down on the page.
        left_down_at: Option<Pt>,
        /// Moving the window with the arrow (its title bar is dragged): where the arrow and the
        /// window's top-left corner were when the button went down.
        window_drag: Option<(Pt, i32, i32)>,
        /// The catcher (see `make_catcher`), whether the page is frozen (it stands under the real
        /// pointer then), and where it stands (None while it is hidden).
        catcher: Option<isize>,
        catching: bool,
        catcher_at: Option<Pt>,
    }

    thread_local! {
        static STATE: RefCell<StandIn> = RefCell::new(StandIn::default());
    }

    fn stand_in_thread(ready: mpsc::Sender<bool>) {
        unsafe {
            let Ok(module) = GetModuleHandleW(None) else {
                let _ = ready.send(false);
                return;
            };
            let class = w!("ZhuPointerStandIn");
            let wc = WNDCLASSW { lpfnWndProc: Some(stand_in_proc), hInstance: module.into(), lpszClassName: class, ..Default::default() };
            RegisterClassW(&wc); // already registered on a second start: fine
            let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
            let Ok(hwnd) = CreateWindowExW(ex, class, w!(""), WS_POPUP, 0, 0, 1, 1, None, None, Some(module.into()), None) else {
                let _ = ready.send(false);
                return;
            };
            // Like the rest of a hidden ZHU, the arrow is left out of captures. (Test harness only,
            // debug builds with ZHU_FREEZE_TEST=visible: in captures, so a screenshot can check it.)
            #[cfg(debug_assertions)]
            let in_captures = std::env::var("ZHU_FREEZE_TEST").as_deref() == Ok("visible");
            #[cfg(not(debug_assertions))]
            let in_captures = false;
            if !in_captures {
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            }
            let catcher = make_catcher(module);
            if catcher.is_none() {
                super::log("the touchpad catcher could not be made; two-finger scrolling over ZHU goes to the window under the real pointer");
            }
            STATE.with(|s| s.borrow_mut().catcher = catcher.map(|c| c.0 as isize));
            SetTimer(Some(hwnd), 1, 100, None);
            refresh();
            STAND_IN.store(hwnd.0 as isize, Ordering::SeqCst);
            let _ = ready.send(true);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                DispatchMessageW(&msg);
            }
            STAND_IN.store(0, Ordering::SeqCst);
        }
    }

    unsafe extern "system" fn stand_in_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match message {
            WM_TIMER => {
                refresh();
                STATE.with(|s| {
                    if let Ok(mut s) = s.try_borrow_mut() {
                        s.place_catcher(true);
                    }
                });
            }
            MSG_ENTER..=MSG_DRAG_WINDOW => {
                let mut at = unpack(lparam.0);
                if message == MSG_MOVE || message == MSG_DRAW {
                    at = latest(hwnd, message, at);
                }
                STATE.with(|s| {
                    if let Ok(mut s) = s.try_borrow_mut() {
                        s.handle(hwnd, message, wparam.0, at);
                    }
                });
            }
            // HTTRANSPARENT: never the window under the pointer.
            WM_NCHITTEST => return LRESULT(-1),
            WM_CLOSE => {
                STATE.with(|s| {
                    if let Ok(mut s) = s.try_borrow_mut() {
                        s.gone(hwnd);
                        if let Some(catcher) = s.catcher.take() {
                            unsafe {
                                let _ = DestroyWindow(HWND(catcher as _));
                            }
                        }
                    }
                });
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
            }
            WM_DESTROY => unsafe { PostQuitMessage(0) },
            _ => return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
        LRESULT(0)
    }

    /// The catcher: a window of one pixel that stands under the real pointer while the page is
    /// frozen, left out of captures and all but clear. A touchpad's two-finger swipe goes to the
    /// window under the real pointer, and not through the mouse hook when that window scrolls
    /// smoothly by itself (browsers and editors take it from the touchpad directly), so it would
    /// scroll the program beside ZHU and not ZHU. Standing there, the catcher gets the swipe as
    /// wheel turns instead and hands them to the page under the arrow.
    fn make_catcher(module: windows::Win32::Foundation::HMODULE) -> Option<HWND> {
        unsafe {
            let class = w!("ZhuPointerCatcher");
            // No cursor of its own: it sets the one the pointer had (WM_SETCURSOR).
            let wc = WNDCLASSW { lpfnWndProc: Some(catcher_proc), hInstance: module.into(), lpszClassName: class, ..Default::default() };
            RegisterClassW(&wc); // already registered on a second start: fine
            let ex = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
            let hwnd = CreateWindowExW(ex, class, w!(""), WS_POPUP, 0, 0, 1, 1, None, None, Some(module.into()), None).ok()?;
            // Nearly clear: a window that is fully clear is not there for the pointer.
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA);
            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            Some(hwnd)
        }
    }

    unsafe extern "system" fn catcher_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match message {
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                // The turn in the high word; of the keys, Shift and Ctrl (a pinch comes as Ctrl and
                // the wheel). Buttons are the arrow's, not the real pointer's.
                let delta = (wparam.0 >> 16) & 0xFFFF;
                let keys = wparam.0 & (MK_SHIFT | MK_CONTROL);
                STATE.with(|s| {
                    if let Ok(s) = s.try_borrow() {
                        if s.catching {
                            WHEELS[WHEEL_CAUGHT].fetch_add(1, Ordering::Relaxed);
                            s.wheel(delta, message == WM_MOUSEHWHEEL, keys, s.at);
                        }
                    }
                });
                LRESULT(0)
            }
            // The window under the pointer gives its shape, or Windows shows its busy one: the
            // shape the pointer had, so viewers see nothing change.
            WM_SETCURSOR => {
                set_catcher_cursor();
                LRESULT(1)
            }
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    /// Keeps the pointer's shape as it is now for the catcher (before it goes under the pointer).
    fn keep_cursor_shape() {
        let mut info = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
        let shown = unsafe { GetCursorInfo(&mut info) }.is_ok() && info.flags.0 & CURSOR_SHOWING.0 != 0 && !info.hCursor.is_invalid();
        CATCHER_CURSOR.store(if shown { info.hCursor.0 as isize } else { 0 }, Ordering::SeqCst);
        set_catcher_cursor();
    }

    /// The shape kept (Windows' own shapes are shared by all programs), or the arrow.
    fn set_catcher_cursor() {
        let kept = CATCHER_CURSOR.load(Ordering::SeqCst);
        unsafe {
            let shape = if kept != 0 { HCURSOR(kept as _) } else { LoadCursorW(None, IDC_ARROW).unwrap_or_default() };
            let _ = SetCursor(Some(shape));
            if kept != 0 && GetCursor() != shape {
                // That program's own shape is gone: the arrow.
                let _ = SetCursor(LoadCursorW(None, IDC_ARROW).ok());
            }
        }
    }

    /// Of movements waiting in a row, only the last matters (Windows does the same with its own),
    /// so a busy moment does not leave the arrow trailing behind.
    fn latest(hwnd: HWND, message: u32, mut at: Pt) -> Pt {
        let mut next = MSG::default();
        unsafe {
            while PeekMessageW(&mut next, Some(hwnd), MSG_ENTER, MSG_DRAG_WINDOW, PM_NOREMOVE).as_bool() && next.message == message {
                if !PeekMessageW(&mut next, Some(hwnd), message, message, PM_REMOVE).as_bool() {
                    break;
                }
                at = unpack(next.lParam.0);
            }
        }
        at
    }

    /// Every 100 ms: the stand-in is alive, and where ZHU's page is.
    fn refresh() {
        BEAT.store(now_ms(), Ordering::SeqCst);
        set_zone(page_zone());
    }

    fn main_window() -> HWND {
        HWND(MAIN.load(Ordering::SeqCst) as _)
    }

    /// The window of ZHU's main window under this point, if ZHU is what is there.
    fn zhu_window_at(at: Pt) -> Option<HWND> {
        unsafe {
            let hwnd = WindowFromPoint(POINT { x: at.x, y: at.y });
            (!hwnd.is_invalid() && GetAncestor(hwnd, GA_ROOT) == main_window()).then_some(hwnd)
        }
    }

    /// The "which keys and buttons are down" bits of a mouse message (MK_LBUTTON, MK_RBUTTON,
    /// MK_MBUTTON, MK_XBUTTON1, MK_XBUTTON2; MK_SHIFT and MK_CONTROL).
    const MOUSE_BUTTON_KEYS: [usize; 5] = [0x0001, 0x0002, 0x0010, 0x0020, 0x0040];
    const MK_SHIFT: usize = 0x0004;
    const MK_CONTROL: usize = 0x0008;
    /// Which X button, in the high word of the X button messages.
    const XBUTTON1: u16 = 1;
    const XBUTTON2: u16 = 2;
    /// The mouse has left the window (its hover effects end).
    const WM_MOUSELEAVE: u32 = 0x02A3;

    fn mouse_keys(held: u8) -> usize {
        let mut keys = 0;
        for (button, bit) in Button::ALL.iter().zip(MOUSE_BUTTON_KEYS) {
            if held & button.bit() != 0 {
                keys |= bit;
            }
        }
        unsafe {
            if GetAsyncKeyState(VK_SHIFT.0 as i32) < 0 {
                keys |= MK_SHIFT;
            }
            if GetAsyncKeyState(VK_CONTROL.0 as i32) < 0 {
                keys |= MK_CONTROL;
            }
        }
        keys
    }

    /// A mouse message for `target`, at a screen point (made relative to the window, as Windows does).
    fn send_mouse(target: HWND, message: u32, wparam: usize, at: Pt) {
        let mut p = POINT { x: at.x, y: at.y };
        unsafe {
            let _ = ScreenToClient(target, &mut p);
            let _ = PostMessageW(Some(target), message, WPARAM(wparam), LPARAM(words(p.x, p.y)));
        }
    }

    fn words(x: i32, y: i32) -> isize {
        ((x as u16 as u32) | ((y as u16 as u32) << 16)) as isize
    }

    fn button_messages(b: Button) -> (u32, u32, u32) {
        match b {
            Button::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK),
            Button::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK),
            Button::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK),
            Button::X1 | Button::X2 => (WM_XBUTTONDOWN, WM_XBUTTONUP, WM_XBUTTONDBLCLK),
        }
    }

    /// The X button messages say which one in the high word.
    fn x_word(b: Button) -> usize {
        match b {
            Button::X1 => (XBUTTON1 as usize) << 16,
            Button::X2 => (XBUTTON2 as usize) << 16,
            _ => 0,
        }
    }

    impl StandIn {
        fn handle(&mut self, arrow: HWND, message: u32, wparam: usize, at: Pt) {
            match message {
                MSG_ENTER | MSG_MOVE => {
                    self.at = at;
                    self.draw(arrow, at);
                    if self.window_drag.is_some() {
                        self.drag_window();
                    } else {
                        self.moved(at);
                    }
                    if message == MSG_ENTER {
                        self.catching = true;
                    }
                    self.place_catcher(false);
                }
                MSG_PRESS => {
                    if let Some(b) = Button::from_index(wparam) {
                        self.press(b, at);
                    }
                }
                MSG_RELEASE => {
                    if let Some(b) = Button::from_index(wparam) {
                        self.release(b, at);
                    }
                }
                MSG_WHEEL => self.wheel(wparam as u16 as usize, wparam >> 16 != 0, 0, at),
                MSG_AWAY => {
                    self.away();
                    self.at = at;
                    self.draw(arrow, at);
                }
                MSG_DRAW => {
                    self.at = at;
                    self.draw(arrow, at);
                }
                MSG_LEAVE => self.gone(arrow),
                MSG_DRAG_WINDOW => self.start_window_drag(),
                _ => {}
            }
        }

        /// A wheel turn (`delta`, the signed turn as 16 bits) for the window under the arrow, or
        /// for the one that got the press of the buttons held; `keys` adds Shift and Ctrl.
        fn wheel(&self, delta: usize, horizontal: bool, keys: usize, at: Pt) {
            if let Some(target) = self.capture.map(|c| HWND(c as _)).or_else(|| zhu_window_at(at)) {
                let message = if horizontal { WM_MOUSEHWHEEL } else { WM_MOUSEWHEEL };
                // The wheel messages carry the point on the screen, not in the window.
                unsafe {
                    let _ = PostMessageW(Some(target), message, WPARAM((delta << 16) | mouse_keys(self.held) | keys), LPARAM(words(at.x, at.y)));
                }
            }
        }

        /// The catcher stands under the real pointer while the page is frozen, and never on the
        /// page itself (the real pointer crosses it while it settles): the arrow would find it
        /// there instead of the page. `check_cover`: also when another window that stays on top
        /// came over it.
        fn place_catcher(&mut self, check_cover: bool) {
            let Some(catcher) = self.catcher.map(|c| HWND(c as _)) else { return };
            let real = cursor();
            let on_page = ZONE.lock().map(|z| z.is_some_and(|z| z.contains(real))).unwrap_or(true);
            if !self.catching || on_page {
                self.hide_catcher();
                return;
            }
            let covered = check_cover && unsafe { WindowFromPoint(POINT { x: real.x, y: real.y }) } != catcher;
            if self.catcher_at.is_none() {
                keep_cursor_shape();
            }
            if self.catcher_at != Some(real) || covered {
                unsafe {
                    let _ = SetWindowPos(catcher, Some(HWND_TOPMOST), real.x, real.y, 1, 1, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
                self.catcher_at = Some(real);
            }
        }

        fn hide_catcher(&mut self) {
            if let (Some(catcher), Some(_)) = (self.catcher, self.catcher_at.take()) {
                unsafe {
                    let _ = ShowWindow(HWND(catcher as _), SW_HIDE);
                }
            }
        }

        fn moved(&mut self, at: Pt) {
            let target = self.capture.map(|c| HWND(c as _)).or_else(|| zhu_window_at(at));
            match target {
                Some(t) => {
                    if self.hover != Some(t.0 as isize) {
                        if let Some(old) = self.hover {
                            unsafe {
                                let _ = PostMessageW(Some(HWND(old as _)), WM_MOUSELEAVE, WPARAM(0), LPARAM(0));
                            }
                        }
                        self.hover = Some(t.0 as isize);
                    }
                    send_mouse(t, WM_MOUSEMOVE, mouse_keys(self.held), at);
                }
                // Another window is in front of ZHU here (a dialog, a menu): the real pointer goes there.
                None if self.held == 0 => RELEASE.store(true, Ordering::SeqCst),
                None => {}
            }
        }

        fn press(&mut self, b: Button, at: Pt) {
            let Some(target) = self.capture.map(|c| HWND(c as _)).or_else(|| zhu_window_at(at)) else {
                RELEASE.store(true, Ordering::SeqCst);
                return;
            };
            if self.held == 0 {
                self.capture = Some(target.0 as isize);
                bring_forward();
                focus_page_at(at);
            }
            self.held |= b.bit();
            if b == Button::Left {
                // Before the page hears of it: the page may ask for a drag of the window at once.
                self.left_down_at = Some(at);
                LEFT_IN_ZHU.store(true, Ordering::SeqCst);
            }
            let (down, _, double) = button_messages(b);
            let now = now_ms();
            let (width, height) = unsafe { (GetSystemMetrics(SM_CXDOUBLECLK), GetSystemMetrics(SM_CYDOUBLECLK)) };
            let takes_double = unsafe { GetClassLongPtrW(target, GCL_STYLE) } as u32 & CS_DBLCLKS.0 != 0;
            let is_double = takes_double && machine::is_double_click(self.last_press, b, now, at, unsafe { GetDoubleClickTime() } as u64, width, height);
            self.last_press = if is_double { None } else { Some((b, now, at)) };
            send_mouse(target, if is_double { double } else { down }, mouse_keys(self.held) | x_word(b), at);
        }

        fn release(&mut self, b: Button, at: Pt) {
            let (_, up, _) = button_messages(b);
            self.held &= !b.bit();
            if b == Button::Left {
                self.end_window_drag();
                self.left_down_at = None;
                LEFT_IN_ZHU.store(false, Ordering::SeqCst);
            }
            if let Some(target) = self.capture {
                send_mouse(HWND(target as _), up, mouse_keys(self.held) | x_word(b), at);
            }
            if self.held == 0 {
                self.capture = None;
            }
        }

        /// The page asked for a drag of the window by its title bar.
        fn start_window_drag(&mut self) {
            let main = main_window();
            let from = self.left_down_at.filter(|_| self.held & Button::Left.bit() != 0);
            let mut rect = RECT::default();
            let movable = unsafe { !IsZoomed(main).as_bool() && GetWindowRect(main, &mut rect).is_ok() };
            unsafe {
                // Tauri waits for the end of a move as Windows' own drag would send it.
                SendMessageW(main, WM_ENTERSIZEMOVE, None, None);
            }
            match from {
                Some(from) if movable => {
                    self.window_drag = Some((from, rect.left, rect.top));
                    self.drag_window();
                }
                // The button is up already (or the window is maximized): the drag is over at once.
                _ => unsafe {
                    SendMessageW(main, WM_EXITSIZEMOVE, None, None);
                },
            }
        }

        /// The window follows the arrow: it keeps the place under the arrow where the drag started.
        fn drag_window(&mut self) {
            let Some((from, left, top)) = self.window_drag else { return };
            unsafe {
                let _ = SetWindowPos(main_window(), None, left + self.at.x - from.x, top + self.at.y - from.y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }

        fn end_window_drag(&mut self) {
            if self.window_drag.take().is_some() {
                unsafe {
                    SendMessageW(main_window(), WM_EXITSIZEMOVE, None, None);
                }
            }
        }

        /// The arrow left the page: buttons still held are released where the arrow is, and the
        /// page no longer has the mouse.
        fn away(&mut self) {
            self.catching = false;
            self.hide_catcher();
            for b in Button::ALL {
                if self.held & b.bit() != 0 {
                    self.release(b, self.at);
                }
            }
            self.end_window_drag();
            LEFT_IN_ZHU.store(false, Ordering::SeqCst);
            if let Some(old) = self.hover.take() {
                unsafe {
                    let _ = PostMessageW(Some(HWND(old as _)), WM_MOUSELEAVE, WPARAM(0), LPARAM(0));
                }
            }
            self.capture = None;
        }

        /// The real pointer has the mouse again: the arrow goes.
        fn gone(&mut self, arrow: HWND) {
            self.away();
            self.image = None;
            unsafe {
                let _ = ShowWindow(arrow, SW_HIDE);
            }
        }

        /// Puts the arrow's tip at `at`, in the size for that screen's scaling.
        fn draw(&mut self, arrow: HWND, at: Pt) {
            let mut dpi = (96, 96);
            unsafe {
                let monitor = MonitorFromPoint(POINT { x: at.x, y: at.y }, MONITOR_DEFAULTTONEAREST);
                let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi.0, &mut dpi.1);
            }
            let image = self.arrows.entry(dpi.0).or_insert_with(|| {
                let made = system_arrow(dpi.0);
                if made.is_none() {
                    super::log("the Windows arrow could not be read; the pointer is not drawn");
                }
                made
            });
            let Some(image) = image.as_ref() else { return };
            let (x, y) = (at.x - image.hot_x, at.y - image.hot_y);
            if self.image != Some(dpi.0) {
                if paint(arrow, image, x, y) {
                    self.image = Some(dpi.0);
                } else {
                    super::log("the arrow could not be drawn");
                }
            }
            // Above every other window, ZHU's own included (a click can bring ZHU above it).
            unsafe {
                let _ = SetWindowPos(arrow, Some(HWND_TOPMOST), x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }
        }
    }

    /// The arrow cursor of the user's Windows pointer scheme, as Windows shows it at this screen
    /// scaling: the scheme's own file read at that size (the best of the sizes it holds), or, if
    /// there is none, Windows' standard arrow.
    fn system_arrow(dpi: u32) -> Option<ArrowImage> {
        let size = machine::cursor_px(cursors_setting_number(w!("CursorBaseSize")).unwrap_or(32), dpi);
        let from_file = cursors_setting_text(w!("Arrow")).filter(|path| !path.trim().is_empty()).and_then(|path| {
            let wide: Vec<u16> = path.trim().encode_utf16().chain(Some(0)).collect();
            unsafe { LoadImageW(None, PCWSTR(wide.as_ptr()), IMAGE_CURSOR, size, size, LR_LOADFROMFILE) }.ok()
        });
        match from_file {
            Some(handle) => {
                let cursor = HCURSOR(handle.0);
                let image = arrow_image(cursor, size);
                unsafe {
                    let _ = DestroyCursor(cursor);
                }
                image
            }
            None => arrow_image(unsafe { LoadCursorW(None, IDC_ARROW) }.ok()?, size),
        }
    }

    /// A cursor drawn at `size`, with its transparency, and where its hot spot is at that size.
    fn arrow_image(cursor: HCURSOR, size: i32) -> Option<ArrowImage> {
        let mut info = ICONINFO::default();
        unsafe { GetIconInfo(HICON(cursor.0), &mut info) }.ok()?;
        // The hot spot is given in the cursor's own picture, which may be another size.
        let picture = if info.hbmColor.is_invalid() { info.hbmMask } else { info.hbmColor };
        let mut bitmap = BITMAP::default();
        let read = unsafe { GetObjectW(picture.into(), std::mem::size_of::<BITMAP>() as i32, Some((&mut bitmap as *mut BITMAP).cast())) };
        unsafe {
            for b in [info.hbmColor, info.hbmMask] {
                if !b.is_invalid() {
                    let _ = DeleteObject(b.into());
                }
            }
        }
        let width = if read > 0 && bitmap.bmWidth > 0 { bitmap.bmWidth } else { size };
        let scale = |v: u32| (v as f64 * size as f64 / width as f64).round() as i32;
        let on_black = draw_cursor(cursor, size, 0x00)?;
        let on_white = draw_cursor(cursor, size, 0xFF)?;
        Some(ArrowImage { pixels: machine::unblend(&on_black, &on_white), size, hot_x: scale(info.xHotspot), hot_y: scale(info.yHotspot) })
    }

    /// The cursor drawn over a plain background (0: black, 255: white), blue-green-red-x.
    fn draw_cursor(cursor: HCURSOR, size: i32, background: u8) -> Option<Vec<u8>> {
        unsafe {
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size,
                    biHeight: -size, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let pixels = match CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(bitmap) if !bits.is_null() => {
                    let len = (size * size * 4) as usize;
                    std::ptr::write_bytes(bits.cast::<u8>(), background, len);
                    let old = SelectObject(memory, bitmap.into());
                    let drawn = DrawIconEx(memory, 0, 0, HICON(cursor.0), size, size, 0, None, DI_NORMAL).is_ok();
                    let _ = GdiFlush();
                    let pixels = drawn.then(|| std::slice::from_raw_parts(bits.cast::<u8>(), len).to_vec());
                    SelectObject(memory, old);
                    let _ = DeleteObject(bitmap.into());
                    pixels
                }
                _ => None,
            };
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            pixels
        }
    }

    /// Windows' pointer settings (HKEY_CURRENT_USER\Control Panel\Cursors): the pointer scheme's
    /// files, and the pointer size.
    fn cursors_setting_text(name: PCWSTR) -> Option<String> {
        let mut buffer = vec![0u16; 1024];
        let mut bytes = (buffer.len() * 2) as u32;
        // A path with %SystemRoot% in it comes back with that filled in.
        unsafe { RegGetValueW(HKEY_CURRENT_USER, CURSORS_KEY, name, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut bytes)) }.ok().ok()?;
        let chars = (bytes as usize / 2).min(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..chars]).trim_end_matches(char::from(0)).to_string())
    }

    fn cursors_setting_number(name: PCWSTR) -> Option<u32> {
        let mut value = 0u32;
        let mut bytes = 4u32;
        unsafe { RegGetValueW(HKEY_CURRENT_USER, CURSORS_KEY, name, RRF_RT_REG_DWORD, None, Some((&mut value as *mut u32).cast()), Some(&mut bytes)) }.ok().ok()?;
        Some(value)
    }

    const CURSORS_KEY: PCWSTR = w!(r"Control Panel\Cursors");

    /// Gives the arrow window its image (with its transparency) and puts it at (x, y).
    fn paint(arrow: HWND, image: &ArrowImage, x: i32, y: i32) -> bool {
        let (width, height) = (image.size, image.size);
        let pixels = &image.pixels;
        unsafe {
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let painted = match CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(bitmap) if !bits.is_null() => {
                    std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast::<u8>(), pixels.len());
                    let old = SelectObject(memory, bitmap.into());
                    let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
                    let ok = UpdateLayeredWindow(
                        arrow,
                        Some(screen),
                        Some(&POINT { x, y }),
                        Some(&SIZE { cx: width, cy: height }),
                        Some(memory),
                        Some(&POINT { x: 0, y: 0 }),
                        COLORREF(0),
                        Some(&blend),
                        ULW_ALPHA,
                    )
                    .is_ok();
                    SelectObject(memory, old);
                    let _ = DeleteObject(bitmap.into());
                    ok
                }
                _ => false,
            };
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            painted
        }
    }

    /// A click in ZHU brings it to the front (Windows would have, for a real click). Windows lets a
    /// program bring itself forward while its input is joined to the window in front.
    fn bring_forward() {
        let main = main_window();
        unsafe {
            let front = GetForegroundWindow();
            if front == main {
                return;
            }
            let me = GetCurrentThreadId();
            let theirs = GetWindowThreadProcessId(front, None);
            let joined = theirs != 0 && theirs != me && AttachThreadInput(me, theirs, true).as_bool();
            let _ = SetForegroundWindow(main);
            if joined {
                let _ = AttachThreadInput(me, theirs, false);
            }
        }
    }

    /// The keyboard goes to the page under the arrow: a chat tab, or ZHU's own page.
    fn focus_page_at(at: Pt) {
        let Some(app) = super::APP.get() else { return };
        let page = crate::webchat::visible_tab_at(app, at.x, at.y).or_else(|| app.get_webview("main"));
        if let Some(page) = page {
            let _ = page.set_focus();
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set_wanted(_wanted: bool) {}
    pub fn install(_window: &tauri::WebviewWindow) {}
}
