# Agent Note: An expanded sidebar overlays the center on narrow frames

Status: implemented

English | [中文](2026-09-26-narrow-sidebar-overlay-drawer.zh.md)

## Problem

Below 1024px the sidebar auto-collapses to the 56px rail, and a manual toggle re-expands it as the first grid track at its normal width (264–420px, default 280px). On a phone frame (390px) that left the center about 110px: Chinese text wrapped to one character per line, the conversation header controls overflowed the frame and were clipped, and choosing a Session kept the sidebar open, so the chosen Session stayed unreadable. The layout had no form in which the sidebar and a usable center could coexist on such a frame. The [responsive Sidebar note](../architecture/2026-09-07-sidebar-responsive-tab-info.md) owns the right column's concessions and the left column's behavior at 1024px and wider; this note covers only the expanded left sidebar below that.

## Decision

`sidebarOverlaysCenter(viewport, sidebar)` in `ui-layout` decides the form: an expanded sidebar overlays the center exactly when the frame is narrower than the resolved sidebar width plus `CENTER_MIN` (400px). In that form the frame sets `data-sidebar-drawer`, gives the sidebar track zero width, positions the sidebar absolutely over the full-width center, and renders a scrim beneath it. The drawer has no resize handle.

The threshold is derived from the two existing contract minimums rather than a new breakpoint constant: it is the point where the track form stops holding both, so a tablet frame that still fits both keeps the column, and a wider stored sidebar switches to the drawer earlier.

The drawer closes through the `collapseOverlaySidebar` store action, which changes only the narrow expansion override and only while the overlay form applies. The scrim calls it, and `AppFrame` calls it when the Session retained by the main view changes. That trigger stays inside `ui-layout`: the Session selection belongs to the Session Controller, and detecting its result avoids adding a layout call to every navigation site in `ui-sidebar`.

## Alternatives considered

**A fixed mobile breakpoint (for example 640px or 768px).** It would duplicate the information already carried by `SIDEBAR_MIN` and `CENTER_MIN` and drift from them when either changes; the derived threshold switches exactly when the track form fails.

**Close the drawer from `ui-sidebar` on every row activation.** This also covers tapping the Session already shown and choosing a global panel, but it spreads a layout concern across the navigation rows of another package and their tests. The README records the remaining open cases as a known limitation.

**Keep the rail visible beside the drawer.** The drawer covers the rail anyway, and a rail track would take 56px from the center behind the scrim for no interaction.

## Consequences

- Frames that fit both columns render exactly as before; desktop layout and the existing 1024px auto-collapse are unchanged.
- The drawer leaves the grid flow, so the center and right columns are pinned to tracks 2 and 3 while it is open; without that, auto-placement moved the center into the zero-width first track. jsdom performs no layout, so this was caught only by a real-browser check at a 390px frame.
- Unit coverage pins the threshold, the store action, the drawer DOM, the scrim, and Session-change closing.
