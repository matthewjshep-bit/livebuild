# MatterMatt

Matterport-style property tours built from **listing photos and a hand-drawn
floor plan** - no depth-sensing camera, no per-scan fee.

## The idea

Standard photogrammetry fails on MLS photos. It needs dense, continuously
overlapping coverage; a listing set is 20-30 wide-angle shots with near-zero
overlap, aggressive HDR, and blown-out windows. Interiors are the worst case
even with good capture, because blank walls give feature matching nothing to
track.

**The floor plan is the unlock.** It supplies exactly what sparse reconstruction
cannot: metric scale, gravity alignment, and global consistency. So this does not
ask photogrammetry to work out the building. It is given the building, and asked
only to work out each photo.

```
Hand-drawn plan  --extrude-->  3D shell = the DOLLHOUSE
       |
       +-- photos placed as posed camera NODES inside it
                    |
                    +-- flat photo               (always works)
                    +-- + AI depth -> 2.5D shell  (parallax, MLS photos)
                    +-- + 3DGS splat             (free-fly, video only)
```

One data model, three renderers that swap in by input quality. The tour never
breaks - it degrades.

### What this gets you

| Feature | From MLS photos |
|---|---|
| Click-to-walk tour | Full. Owes nothing to photogrammetry. |
| Dollhouse + floor plan | Full. Extruded from what you drew. |
| Free-fly photoreal 3D | **Constrained, not free** - see below. |

A single photo plus AI depth gives a *2.5D shell*: real parallax when the camera
moves a little, but it tears at depth edges when it moves a lot, because nothing
was ever recorded behind the sofa. Matterport has the same limitation and hides
it by constraining motion. So does this. Genuine free-fly needs a walkthrough
video, which is the Phase 3 path.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Then click **Make a tour**.

## Scope of work and costs

`/bom/<id>` — an indented bill of materials per room, totalling the rehab work
against each room's current state. This is what the model was built for.

A PLM tool derives its quantities from CAD. There is no CAD here, but the model
carries the same information, and `src/lib/bom/takeoff.ts` reads it out: floor
and ceiling area, wall area **net of door and window openings**, baseboard run,
door and window counts, per room. It reuses `wallSegmentsForRoom`, which already
subtracts doorways for the renderer — so the BOM and the model can never
disagree about where a door is.

Three inputs, multiplied:

| | Source |
|---|---|
| **Quantity** | Measured from the model. Derived, never stored. |
| **Condition** | Graded per element from the room's photos. Stored — it is an observation you correct. |
| **Rate** | An editable per-unit card, seeded with US mid-grade defaults. |

Condition decides which lines exist at all. `good`/`fair` produce nothing;
`dated` refreshes (reface the cabinets); `poor` replaces (new cabinets). The
grades come from the wholesaling repo's photo scan, and the distinction between
**dated** — works, looks wrong — and **poor** — failing — is the one that
decides the money.

Each line declares what it depends on and when it fires, so selection is
declarative rather than branching:

```ts
{ label: "Base cabinets", unit: "lf", quantityFrom: "cabinetRunLf",
  dependsOn: "cabinets", triggersAt: ["poor"] }
```

**Unseen is not the same as fine.** An element no photo showed is graded
`not_visible`, costed as nothing, and flagged in the tree — with the share of
the total resting on assumptions shown at the top. A room quietly costed as
ruined would be wrong, expensive and invisible.

**There is a whole-house section** — roof, systems, exterior — because a rehab
total that omits a $12,000 roof is not a rehab total. Those are priced flat with
the size factor from `whole-house.ts`, since a house has one roof however many
rooms it has. Windows are the exception: the model knows how many there are.

**And a sanity check.** The itemised total is placed against whole-project cost
ranges by house size, ported from the same repo. The two are computed from
entirely different things, so agreement means something — and a badly wrong rate
card shows up rather than passing silently.

Export is CSV, one row per line with its full path, because the first thing
anyone does is pivot it in a spreadsheet.

## The model

The rendered model is the foundation, not the photographs. It exists before any
photo does, never degrades because the photography was poor, and is the same
artefact whether the house is furnished, empty or unbuilt.

`src/lib/model/` builds it from the plan:

| | |
|---|---|
| `walls.ts` | Wall solids with real thickness, built **once** per shared wall |
| `windows.ts` | Windows derived on exterior walls |
| `furniture.ts` | Procedural furniture by room kind |
| `materials.ts` | The palette |

Three things are worth knowing about how it is built.

**A shared wall is one wall.** Each room used to draw its own, so a partition
between two rooms was two coincident zero-thickness planes. Every storey is now
resolved into a single wall graph first: collinear edges from adjoining rooms are
paired and emitted once at 100mm, unpaired edges become exterior walls at 200mm,
offset outward so rooms keep the internal dimensions they were given.

**Doorways get a header.** The wall above an opening, from 2.05m to the ceiling.
It costs almost nothing and it is the single detail that makes a doorway read as
a door rather than as a wall that stopped.

**Walls, windows and furniture are all derived, never stored** — as doorways
already were. Nothing needs migrating, documents stay small, and improving any of
these improves every tour already built.

Furniture is procedural: a bed is a base, a mattress and pillows, assembled from
boxes in code. Sourced models would look better and bring asset licences,
megabytes of download, and a house that cannot be furnished offline. One rule is
absolute — **nothing may block a doorway** — because a sofa across the only door
is wrong in the model *and* in the walk graph that routes people through it.

Photographs are still there. Where a room has them, stepping inside swaps in the
2.5D shell renderer described below.

## Making a tour

**Drop in your photos and press one button.** That is the whole required flow.

Everything else is inferred from the photos: which room each one is, how the
rooms connect, what shape the house is, and where each shot was taken from. It
takes about a minute, and then shows you what it built so you can correct
anything before opening it.

Two optional things make it closer to your house, and neither is required:

- **A sentence about the house** ("two storey 3 bed 2.5 bath, primary upstairs
  with an ensuite"). This mainly helps it tell three bedrooms apart.
- **A drawing of the layout** — see below. This is the strongest signal of all,
  because arrangement is the one thing photos struggle to pin down.

### How the shape is worked out

Layout is where a generated plan either reads as *your* house or as merely a
house, and the strongest free signal turns out to be in the photos themselves:
**a kitchen shot that shows the dining room through an opening says those two
rooms touch.** Every photo is checked for what it connects to, and those
observations then drive the arrangement — packing order is searched over until as
many of them are satisfied as the geometry allows.

Exact dimensions matter far less than this. A plan with the right rooms in the
right relationship reads as correct even when every measurement is approximate;
a plan with perfect square footage and the bedrooms on the wrong side does not.

## Drawing the floor plan

Dragging rectangles into the right arrangement is the worst part of the builder,
and polish does not fix it: the layout already exists in your head and a mouse
is a slow way to get it out.

So draw it instead. **Draw the layout** in the layout step opens a pad: drag to
draw walls, switch to *Add a name* and click inside each room to label it. Or
switch to *Photo of paper* if you would rather sketch on a notepad and
photograph it — both go through the same reading pipeline.

A box per room with the name in it is all it needs.

Write a size like `12x14` inside a room and everything scales from it. Several
rooms with dimensions are better than one - the scale comes from all of them at
once, matching total written area against total drawn area, so one sloppy
rectangle cannot set the size of the house. A sketch is never to scale, so this
puts the error into each room's *shape* rather than the house's *size*.

### What it keeps, and what it throws away

Your drawing is read for its **structure**, not its measurements. Which rooms sit
beside which, what lines up with what, what touches what — that is the content of
a sketch. The proportions are not: a room comes out big because that is where
your pen stopped.

So the arrangement is kept exactly, and the dimensions are **solved for afresh**.
Every distinct edge becomes a grid line, each room spans a block of cells, and
the column widths and row heights are then chosen to put each room near a
plausible size for what it is. Anything you wrote down is treated as near-fixed;
everything else is a preference. Walls end on 6-inch increments.

A hallway drawn as a fat band a quarter of the page deep comes out as a
22 x 4 ft corridor. Nothing you drew moves; it just stops being shaky.

Where the drawn structure and plausible sizes genuinely conflict — a bathroom
sharing a wall with a bedroom must be as deep as it — the structure wins, and the
room lands as close as the grid allows. It tells you what it changed.

Edge clustering runs first and matters more than it sounds: doorways are derived
from adjacency, so rooms that *almost* touch produce a house nobody can walk
through.

Room names need not match what you tagged photos with. A sketch saying "Bath"
and a photo tagged "Bathroom" are matched anyway - exact names first, so a loose
match cannot steal photos that had a perfect home, then whatever is left by
resemblance. Anything still unplaced is reported rather than dropped.

`public/fixtures/sketch-floorplan.jpg` is a generated notepad sketch with known
ground truth, used by `tools/sketch-test.ts`.

## Importing a listing

Paste an address and get the photos, plus the facts that matter: bedroom and
bathroom counts, and **square footage**.

The square footage is the point. Room sizes otherwise come from a table of
typical dimensions, so a 900 sqft cottage and a 3,000 sqft house generate nearly
the same dollhouse - and every distance inside the tour is wrong by the same
factor. Given a real number, the plan is scaled to match (excluding the garage,
which listings do not count as living area).

Lookup runs through Apify's Zillow scraper, ported from the prvt-reviews
wholesaling repo - see `reference/README.md` for what was taken and, more
usefully, what was deliberately left behind. Set `APIFY_TOKEN` to enable it;
without one the box is hidden and photos are added by hand.

Photos are fetched through `/api/listing/photo`, an allowlisted proxy. Zillow
serves images happily but sends no CORS headers, so the browser cannot otherwise
read the bytes to store them.

## Placing photos where they were taken

Photos are dropped into their room by a heuristic — a corner, facing the middle
— which is a fair description of how listing photos are shot and wrong often
enough to matter. A galley kitchen shot down the counter run, a bathroom taken
from the doorway, or a bedroom framed from the foot of the bed all end up facing
the wrong way, and the tour turns to look at a wall.

So before depth is computed, each photo is examined against everything already
known about its room: its dimensions, and **which walls have doorways**. A
doorway in shot fixes the orientation outright; failing that, the geometry of
converging walls says which corner is furthest.

A refined pose is only applied when the model is confident. That restraint is the
point — a confident wrong pose overrides a heuristic that was probably right,
whereas an admitted uncertain one costs nothing.

Order matters here: poses are refined **before** depth, because the far anchor
that turns relative depth into metres depends on which way the camera faces. Get
the heading wrong and a wrong scale is baked into every shell.

Measured against the synthetic demo house, the only fixture with exact ground
truth: one of six photos was confident, and it landed within **1° of heading and
1% of position**. The other five were correctly flagged uncertain and kept the
heuristic. Bare synthetic rooms are close to the worst case for this — real
photos have doorways, windows and furniture to read.

## Labelling photos automatically

On the room step, **Label all N for me** runs a vision pass that assigns each
photo a room from *this house's own list* - so it answers "Primary Bedroom", not
a generic "Bedroom" that cannot tell three of them apart. It also groups photos
of the same physical room.

Each label carries a confidence, and low-confidence ones are surfaced for review
rather than buried. That flag is doing real work: on deliberately ambiguous
images the model marks almost everything low, and the one thing it marks high is
the one thing it gets right.

**Accuracy on real photos is untested.** The bundled demo house is synthetic -
flat untextured boxes - and the model scores 2-3 out of 6 on it at every
resolution, correctly flagging its own uncertainty. Real listing photos carry
far more signal, but that is a reasonable expectation, not a measurement.

## Describing the house

Two paths, and the offline one is the default:

**A parser** (`src/lib/plan/describe.ts`) runs first and instantly. Real
descriptions are far more structured than they look - "3 bed 2 bath, open plan
kitchen and living, primary has an ensuite, two-car garage" is almost a data
format - so it handles the common case with no key, no network and no cost. It
knows that 2.5 baths means a powder room, that a master suite implies an
ensuite, that "3br" and "three bedrooms" are the same thing, and that bedrooms
belong upstairs in a two-storey house.

**Claude** then has a go at the same text, and only replaces the result if it
succeeds. This is for genuine prose the parser cannot crack. It needs a key:

```bash
cp .env.example .env.local     # then add ANTHROPIC_API_KEY
```

Without one the wizard says so and carries on with the parser - no errors, no
dead ends. The request runs server-side (`src/app/api/describe/route.ts`) using
`client.messages.parse()` with a Zod schema, so the key never reaches the
browser. **Only the description text is sent - never a photo.**

Either way you can see exactly what was understood, split by floor, before
anything is built.

## Publishing

Drafting is local by design - tagging thirty photos should not wait on a network,
and nothing leaves the machine until you decide. **Publish** is that decision: it
uploads once and gives you a link anyone can open.

```
livebuild.ai/          build tours (passphrase-gated)
livebuild.ai/t/<slug>  a published tour — no account, nothing to install
```

Photos are downscaled to 1600px on the way out (a raw set is ~90MB; this makes
it 8-12MB). Depth maps are uploaded untouched, because they encode millimetres
across RGB channels - resampling them would corrupt geometry rather than soften
an image.

Uploads go **straight from the browser to Supabase** using short-lived signed
URLs the server mints. They have to: a Vercel function caps request bodies near
4.5MB, and a house is far larger than that. It also means the write credential
never reaches a browser.

A viewer downloads no model. Depth was computed once, by whoever built the tour.

Setup is in `DEPLOY.md` (Vercel + Cloudflare DNS) and `supabase/README.md`
(database + bucket). Without any of it configured the Publish button simply does
not appear, and everything local keeps working.

## Storage

Everything lives in the browser - no account, no server, and no photo leaves the
machine.

| What | Where | Why |
|---|---|---|
| Property documents | localStorage | Kilobytes, and the editor's autosave is synchronous |
| Photos and depth maps | IndexedDB (`media`) | Tens of megabytes; would blow localStorage's quota instantly |
| Wizard drafts | IndexedDB (`docs`) | Same store, different lifetime |

Two things follow from that, and both were bugs before they were features:

**Photos are written the moment they are chosen, not when the tour is built.**
A `File` handle does not survive a reload, so anything held only in React state
is already gone. Returning to `/new` offers to pick up where you left off.

**Depth is resumable.** Inference runs on the page that started it, so leaving
early used to strand a tour with `depth: null` forever and nothing offering to
retry. The tour now notices and offers to finish; each map is saved as it lands,
so a second interruption still keeps the work already done.

`/storage` shows what is held, how much room it takes, and lets you export,
import or delete. It also asks the browser to mark the data persistent -
otherwise IndexedDB is best-effort and can be evicted under storage pressure.

Export writes the plan, not the photos. An imported plan gives you rooms and a
dollhouse with the photos missing.

## Multiple storeys

Rooms carry a `level`; every storey shares one plan-space coordinate system,
which is what lets stairwells line up and lets the dollhouse stack them. Two
consequences worth knowing:

- **Stacked rooms are not connected.** A floor is not a doorway. Storeys join
  only through stairs, and stairs are derived the same way doorways are: two
  `Stairs` rooms whose footprints overlap on adjacent levels.
- **A cross-storey ring is drawn at the stairs, not at the node.** The viewpoint
  itself is metres above your head, and a ring floating in the ceiling is not
  something anyone reads as "go this way".

The dollhouse gets floor tabs, and the minimap can browse a storey you are not
standing on - otherwise the rooms you cannot see are also the ones you cannot
navigate to.

## Layout

```
src/
  app/new/              # the 4-step wizard - the way in
  lib/
    schema.ts           # the property document - the contract between phases
    plan/autolayout.ts  # build a plan from room names; derive doorways
    plan/geometry.ts    # extrusion, wall/doorway subtraction, plan<->world
    plan/walkgraph.ts   # which viewpoints connect, derived from doorways
    depth/              # in-browser depth estimation (worker + client)
    render/depth-shell.ts  # the 2.5D shader
    media-store.ts      # photos in IndexedDB, referenced as idb:<key>
  components/
    wizard/             # drop photos, tag rooms, arrange
    editor/             # advanced: draw the plan by hand
    tour/               # dollhouse, shells, camera rig, minimap
pipeline/               # Python. Optional now - see below.
tools/                  # headless-browser verification
```

## Verifying it

WebGL cannot be checked by asserting a route returns 200 - the scene is built
entirely on the client. These drive a real browser:

```bash
npx tsx tools/takeoff-test.ts    # quantities derived from the model hold together
npx tsx tools/bom-test.ts        # rollups add up; condition drives scope
npx tsx tools/room-kind-test.ts  # every room name resolves to the right kind
npx tsx tools/walls-test.ts      # shared walls built once, doorways cut, headers above
npx tsx tools/furniture-test.ts  # furniture fits its room and never blocks a door
npx tsx tools/sketch-test.ts     # a hand-drawn plan becomes a connected, correctly-scaled one
npx tsx tools/describe-test.ts   # descriptions parse, lay out connected, and scale to sqft
npx tsx tools/layout-test.ts     # every generated plan is fully walkable
npx tsx tools/floors-test.ts     # storeys, stairs, and pass-through rooms
node tools/parallax-test.mjs     # the shell is 3D, not a billboard
node tools/walk-test.mjs         # you can step between viewpoints
node tools/floors-walk-test.mjs  # you can actually get upstairs, two ways
node tools/builder-test.mjs      # add a room, rotate it, add a storey
node tools/author-test.mjs       # the advanced editor still works
node tools/wizard-test.mjs       # photos in, walkable tour out (slow: downloads the model)
node tools/describe-flow-test.mjs # describe -> tag options -> multi-storey layout (calls the API)
node tools/model-test.mjs         # the model renders on both plans; photos still work
node tools/bom-page-test.mjs      # grade from photos, render the BOM, export CSV (calls the API)
node tools/sketch-flow-test.mjs   # upload a drawing, get a layout (calls the API)
node tools/pose-test.mjs         # camera poses scored against exact ground truth
node tools/autotag-test.mjs       # the vision pass labels every photo from the house's own rooms
node tools/persistence-test.mjs   # work survives a reload; depth can be resumed
node tools/publish-test.mjs       # publish, then load the link with empty storage (needs Supabase)
node tools/shoot.mjs "/tour/demo-house?node=n1" shots/inside.png
```

Two of these carry most of the weight.

`parallax-test` compares how much a near silhouette moves against how much the
flat wall behind it moves under camera lean. A billboard shifts as one rigid
image; a depth shell does not. Currently **3.4x**.

`layout-test` checks the auto-layout's one hard promise - that every room it
generates is reachable from every other. It is a plain reachability check across
47 house shapes, and it caught two failures a single browser run had missed.

`floors-walk-test` clicks its way upstairs. Worth having because the cross-storey
case fails in a way stills cannot show: a ring can be present and clickable while
being invisible, or drawn somewhere nobody would ever click.

## Status

- **Phase 0** - spike ready to run, needs your photos. See `pipeline/README.md`.
- **Phase 1** - done. Plan editor, dollhouse, walk graph.
- **Phase 2** - shell renderer done and verified. Wire real depth maps in once
  Phase 0 says the photos survive.
- **Phase 3** - not started. `splats` exists in the schema so it drops into the
  same world frame when it arrives.

## The next thing to do

Run the Phase 0 spike on one real property. Everything else here is
well-understood engineering; whether monocular depth survives real MLS photos is
the only genuinely uncertain part, and it is cheap to answer.
