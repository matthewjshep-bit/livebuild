# Livebuild.ai

Hyper-realistic 3D replicas of houses, built from **photographs, satellite
imagery and the map** - no depth-sensing camera, no per-scan fee.

> **On the name.** The product is Livebuild.ai; the plumbing still says
> `mattermatt`, and that is deliberate rather than a rename left half-done.
> Anything that has to agree with something *outside* this repository keeps the
> old name - the browser-storage keys and IndexedDB database holding houses
> people have already built, the `MATTERMATT_ADMIN_KEY` set in the hosting
> dashboard, and the npm/repo name. Renaming those does not move the thing they
> point at, it abandons it. Everything a user reads is Livebuild.ai. The storage
> side is named once in `src/lib/storage/namespace.ts`, so switching it later is
> one edit plus a migration.

## The idea

The photographs are evidence, not scenery. Nothing you took a picture of is
shown to you as a picture: the pictures are read, and what they describe gets
built.

That is the whole design, and it is a reversal. This used to pose each
photograph inside an extruded floor plan and render it as a 2.5D shell, so the
plan was a backdrop and the photography was the product. It worked, and it
carried the limitation photography always carries - a shell holds together only
near the spot it was shot from, so the camera could never really move, and
anything the lens did not see was simply absent.

A built replica has no such limit. You can walk it, stand anywhere, look at the
back of the sofa, take it apart, and price it - because every surface is
geometry with a material on it rather than a projection of a moment.

```
    photos ──┐
  satellite ──┤
 street view ──┼──► read ──► what the house IS ──► built ──► one model
    the map ──┤              rooms, finishes,              you can walk,
   the plan ──┘              openings, fittings            price and share
```

Many inputs, one renderer. Every input that fails is an input the model simply
does without: no address means no sun, no photograph of a room means that room
is inferred from the plan and the rooms around it. Nothing blocks the build.

### What this gets you

| Feature | From listing photos |
|---|---|
| Walk it in first person | Full. Real collision, real stairs, real doorways. |
| Dollhouse + floor plan | Full. Extruded from the footprint. |
| Photoreal free movement | Full - there is no shell to tear, because there is no shell. |
| A priced scope of work | Full. Quantities come off the model, condition off the photos. |

The trade is honest and worth stating: a replica is only as right as what was
read out of the inputs. A photograph shows you a real kitchen and can be wrong
about nothing; a replica of that kitchen can be confidently wrong about the
cabinet doors. So the photographs are kept, beside the model rather than in it,
and every room can be checked against the pictures it was built from.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Then click **Make a tour**.

Before pushing anything:

```bash
npm run typecheck
npm run lint
npm test             # the pure suites, about four seconds
```

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

### Scope follows what you are looking at

The scope page answers "what does this house need". The pane in the model
answers "what about *that*", which is the question people actually ask while
walking a property.

- **Walk into a room** and its scope appears unasked — the room you are standing
  in is the room you are asking about.
- **Click a surface** — a floor, a bath, a worktop — and it narrows to that item,
  with its quantity, rate and material/labour split.
- **Grade it in place.** The condition selector is in the pane, because the
  judgement happens at the point of looking. Mark a worktop dated and the total
  moves immediately; making someone leave, find a list and come back is how a
  tool stops being used.

Making this work meant re-keying the model's geometry merge from colour to
**room and element**. Merging by colour was cheaper and left the model anonymous
— there was no way to ask what you had clicked. A house is now sixty-odd meshes
instead of ten, which is nothing, and it can be interrogated.

Fixtures map to line items; staging does not. Clicking a bath selects the bath;
clicking a bed selects its room, because a bed is there to make the room read as
lived in and replacing it is not rehab scope.

**A published tour shows none of this.** The pane only appears for a property
stored locally — someone opening a shared link is looking at a listing, not at
what it would cost to fix.

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
| `textures.ts` | Colour and height, drawn to a canvas at runtime |
| `maps.ts` | Normal, occlusion and roughness derived from that height |

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

Photographs are still there, beside the model rather than in it: a panel lists
the pictures a room was built from, and any of them opens full-screen. That is
the check on the whole approach - a replica can be confidently wrong in a way a
photograph cannot, so the photograph stays within reach.

## Making a tour

**Drop in your photos, say what is in the house, and draw the layout.** Three
screens, and the third is a pen.

Everything else is inferred from the photos: which room each one is, how the
rooms connect, what shape the house is, and where each shot was taken from. It
takes about a minute, and then shows you what it built so you can correct
anything before opening it.

Drawing is not optional for a house, and that is a deliberate reversal. It used
to be a button hidden inside the satellite editor, so the hardest surface was
the default and the easiest one was behind it — everybody dragged rectangles,
and the drawing arrived too late to inform the room list or the classifier. Now
the arrangement is the thing you are asked for, because arrangement is the one
thing photographs struggle to pin down and the one thing you already know.

A single room (**A room**, at the first screen) skips all of it: there is no
arrangement to draw for one space.

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

So draw it instead, and draw it *first*. Drag to draw walls, one line per wall.
Or press **I already have it on paper** if you would rather sketch on a notepad,
or already have a floor plan from a listing — both go through the same reading
pipeline.

A box per room with the name in it is all it needs. A house with more than one
storey is drawn a floor at a time, from tabs above the pad, and each floor needs
a staircase — a storey with no way up it is refused, because that mistake is
invisible on the plan and only shows up when somebody walks the tour.

### The rooms appear as you close them

The pad shows what your walls have actually made. Every enclosed space is
tinted the moment its last wall lands, the one under the cursor lights up, and
the naming card stands beside that space rather than on top of it — so "which
room am I naming" is answered before you commit rather than by a refusal
afterwards. The names on offer are the ones the house sheet says the house has,
so naming a room is a press.

This matters more than it sounds. Two rooms that came out as one because a wall
missed by a hair are now *visible* as one shape, which is the only way anybody
was ever going to find that out.

### You draw on top of the building

When the address gave a surveyed outline, that outline is on the pad before you
start — the real shape, dashed, framed to fill the paper. Trace it and the house
comes out this building's shape rather than a rectangle to be repacked
afterwards, and the pad's scale is fixed, so what you draw is already in metres.

### Then it is fitted to the building

A drawing has no scale of its own — a room came out big because that is where
your pen stopped. So once the photos have been read and the building's outline
is known, the arrangement you drew is packed into that outline: which room is
where is kept exactly, and only the dimensions are given up to the shape the map
measured. What lands on the satellite step is your plan, already placed.

Nudging is still there, and it can now hit a number: walls land on six-inch
increments, and a selected room takes a width and depth in feet typed straight
in. Dragging a rectangle over a photograph was never going to land on a
measurement somebody took with a tape.

With no address there is nothing to fit to, and the floor area from the house
sheet sets the size instead.

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
ground truth, used by `tools/sketch-test.ts` and by the photo-of-paper half of
`tools/sketch-flow-test.mjs`.

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

## Attaching photos to rooms

A photograph belongs to a room, and that is now the whole of the relationship.
It used to be a camera: a position, a heading, a lens angle and a parallax
budget, all of which existed because the picture was rendered from exactly where
it was taken. None of that is read any more.

The fields are still on the schema and still written, so every document saved or
published before this change parses unchanged and every published link keeps
working - but nothing looks through them. The pose pass survives for one reason
only: which way a camera was facing is useful for *understanding* a room, and
that is what the photographs are for now.

## Materials and light

The house is drawn in code and nothing is downloaded. That was already true of
the surface colours and it is now true of the whole physically-based set:

**Height is drawn, never inferred.** Every finish generator draws twice from the
same seed - once in colour, once in greys saying where the surface stands high
and low - and the normal, occlusion and roughness maps come off the second pass.
Deriving relief from the colour instead is the classic mistake: a dark board
becomes a groove, a pale vein becomes a ridge, and the result is an embossed
picture of a surface rather than a surface. Grout is recessed because it is
recessed; oak grain is flat because it is flat.

**The sky is something to reflect.** An environment map, painted as a gradient
with the sun in the right place and convolved at 128px. Nothing metal reads as
metal without one - a mirror with nothing to mirror is a grey square - and glass
reads as a pale panel. It also does properly what five shadow-casting
directional lights used to approximate, which is why there is now one shadow map
in the scene instead of six.

**A window is a light.** Image-based lighting ignores occlusion, so it lights
the inside of a sealed box exactly as brightly as the outside and every wall
comes back the same tone. A window genuinely is a rectangle of sky facing into a
room, so it is modelled as one - and that is what gives an interior light that
falls off with distance from the openings.

**Everything made has a filleted edge.** Three millimetres, which is what a
router leaves. A sharp arris gives the eye one hard discontinuity; a filleted one
gives it a band that catches a highlight, and that band is most of the
difference between a box and an object. Not on walls or floors, where it would
never be seen and the vertices are not free.

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

## Reading the rooms

The plan says where the walls are. The **spec** says what they are made of, and
it is the difference between a house and *this* house. It is read out of the
photographs after the tour is already on screen, one request per room, and
stored against the property keyed by room id.

`src/lib/spec/` holds it, and four rules do most of the work.

**It hangs off `Property`, never off `Room`.** A re-layout regenerates
`Plan.rooms` wholesale, so anything stored on a room is destroyed by a rebuild
with no error at all. `condition` had already solved this; the spec takes the
same path.

**Every value knows where it came from.** A field read off a photograph, a field
a person typed and a field the house merely assumed are three different kinds of
claim. `source` ranks them, so a re-read cannot quietly overwrite a correction.

**The model says what, the standards say how big.** A vision model recognises
well and measures badly, and a wrong dimension is wrong by a constant factor
while looking entirely self-consistent. So a reading within tolerance of a stock
size - a 140mm skirting board, a 2.44m ceiling - becomes that size, and a
reading outside every tolerance is kept exactly as it came and flagged, because
a house genuinely can have a 2.2m ceiling.

**The rooms nobody photographed are reasoned about, not defaulted.** A listing
set covers what sells a house and misses the landing, the second bathroom and
the fourth bedroom - and those have to be built too. Defaults are per-room and a
house is not: a landing in generic oak between two rooms in a specific walnut
reads as a mistake rather than as an unphotographed landing. So `infer.ts` works
out the house's own conventions from what was seen and applies those.

And the loop that checks a render against the photograph it came from is bounded
by arithmetic rather than by good behaviour - a round is kept only if the score
improves, a field that oscillates is frozen, anything a person touched is final,
and it stops. A model looking at two images will always find something to say,
and a loop that acts on all of it walks a correct room steadily away from
correct.

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
| Photos | IndexedDB (`media`) | Tens of megabytes; would blow localStorage's quota instantly |
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
- **The way up is marked at the foot of the flight, not at the top of it.** The
  landing is metres above your head, and a marker floating in the ceiling is not
  something anyone reads as "go this way". It stands clear of the treads too,
  because a marker is drawn without depth testing so it stays *visible* through
  the staircase, while a click is a ray that stops at the first tread.

The dollhouse gets floor tabs, and the minimap can browse a storey you are not
standing on - otherwise the rooms you cannot see are also the ones you cannot
navigate to.

## Layout

```
src/
  app/new/              # the wizard - photos, sheet, pen, confirm
  lib/
    schema.ts           # the property document - the contract between phases
    units.ts            # metres are canonical; also the grid every wall lands on
    plan/strokes.ts     # pen strokes to rooms - straighten, weld, walk the faces
    plan/drawn.ts       # check a drawing, and fit its arrangement to a building
    plan/autolayout.ts  # build a plan from room names; derive doorways
    plan/geometry.ts    # extrusion, wall/doorway subtraction, plan<->world
    plan/walkgraph.ts   # which rooms connect, derived from doorways
    build/arrange.ts    # where the rooms go when nobody drew them
    spec/               # what each room is made of - read, reasoned, verified
    model/textures.ts   # colour and height, drawn to a canvas at runtime
    model/maps.ts       # normal / occlusion / roughness, derived from height
    render/quality.ts   # what this machine can afford to render
    media-store.ts      # photos in IndexedDB, referenced as idb:<key>
  components/
    wizard/             # drop photos, say what is in it, draw it, confirm
    wizard/useDrawing   # the drawing, across every storey - one concern, one place
    editor/             # advanced: adjust a finished plan, place cameras, reshape
    tour/               # dollhouse, walk, lighting, post, camera rig, minimap
pipeline/               # Python. One fixture generator, and nothing at request time.
tools/                  # the suites - `npm test`, and `--browser` for the rest
```

## Verifying it

WebGL cannot be checked by asserting a route returns 200 - the scene is built
entirely on the client. So half of the suites drive a real browser, and half are
pure and do not.

```bash
npm test          # the pure half - no browser, no network, about four seconds
npm run test:browser   # the browser half - needs `npm run dev` running
npm run test:all       # both
npm test -- plan       # anything whose name matches
```

Both halves used to be runnable only one file at a time, from a list here that
had drifted to a third of what is in `tools/`. Nobody ran them, and four suites
were failing on `main` at once - each since whichever change broke it. Every
suite now gets a deadline too, because a run that hangs is worse than one that
fails: it gets killed, and then nobody knows what passed.

The ones worth knowing by name:

```bash
npx tsx tools/takeoff-test.ts    # quantities derived from the model hold together
npx tsx tools/bom-test.ts        # rollups add up; condition drives scope
npx tsx tools/room-kind-test.ts  # every room name resolves to the right kind
npx tsx tools/walls-test.ts      # shared walls built once, doorways cut, headers above
npx tsx tools/furniture-test.ts  # furniture fits its room and never blocks a door
npx tsx tools/strokes-test.ts    # pen strokes become the rooms they enclose, or a refusal
npx tsx tools/drawn-test.ts      # a drawing is checked, and fitted to a real building
npx tsx tools/sketch-test.ts     # a photographed plan becomes a connected, correctly-scaled one
npx tsx tools/describe-test.ts   # descriptions parse, lay out connected, and scale to sqft
npx tsx tools/layout-test.ts     # every generated plan is fully walkable
npx tsx tools/floors-test.ts     # storeys, stairs, and pass-through rooms
npx tsx tools/reshape-test.ts    # a finished tour reshapes without orphaning anything
npx tsx tools/imagery-test.ts    # the geo maths behind the satellite trace
node tools/replica-test.mjs      # no photograph is ever drawn in the model
node tools/walk-test.mjs         # a room marker puts you inside, on foot
node tools/floors-walk-test.mjs  # you can actually get upstairs, two ways
node tools/builder-test.mjs      # add a room, rotate it, type its size, add a storey
node tools/author-test.mjs       # the advanced editor still works
node tools/model-test.mjs        # the model renders on both sample plans
node tools/freehand-test.mjs     # draw a house with a pointer; spaces light up as they close
node tools/layout-stage-test.mjs # the drawing arrives fitted, and a hole still refuses to build
node tools/oneclick-test.mjs     # photos in, walkable tour out
node tools/persistence-test.mjs  # work survives a reload with its photos attached
node tools/bom-page-test.mjs     # grade from photos, render the BOM, export CSV (calls the API)
node tools/publish-test.mjs      # publish, then load the link with empty storage (needs Supabase)
node tools/shoot.mjs "/tour/demo-house?room=kitchen" shots/inside.png
```

Two of these carry most of the weight.

`replica-test` is the one that guards the direction of the whole project. It
walks the scene graph in four views - dollhouse, on foot, two-storey, and the
scripted tour - and fails if any material carries a texture whose image was
fetched rather than generated. A photograph creeping back onto the model would
not break anything or throw anything; it would just quietly undo the point. The
procedural canvas textures have no `src`, so they do not trip it.

`layout-test` checks the auto-layout's one hard promise - that every room it
generates is reachable from every other. It is a plain reachability check across
47 house shapes, and it caught two failures a single browser run had missed.

Anything reading `window.__scene` waits for its `mode` field rather than for a
fixed number of seconds. The readout is published once a second, so a test that
sleeps and hopes is a test that passes on a fast machine and fails on a slow
one - which is how both walk tests were flaky before they waited on state.

## Status

- **Photographs off the model** - done. The shell renderer, the depth pass and
  the node-teleport camera are gone; `@huggingface/transformers` with them.
- **Materials and light** - done. Procedurally derived normal, occlusion and
  roughness maps; a procedural environment map for image-based lighting; one
  sun instead of six shadow maps; windows as real area lights; bevelled edges
  on everything that is an object; SMAA, occlusion and a restrained bloom
  behind a three-tier quality setting.
- **The interior spec** - done, and described above. Read per room, reasoned
  across the house for the rooms nobody photographed, snapped to the sizes
  things are actually built to, and checked against the photographs it came
  from. What remains is breadth - more fields, read more reliably - rather than
  a thing that does not exist.
- **The parts library** - not started. Cabinetry with doors and handles, lathe
  sanitaryware, real window assemblies with reveals and mullions, replacing the
  one-to-three-slab builders in `src/lib/model/furniture.ts`. This is now the
  limit: the spec can say a kitchen has shaker doors in a particular green, and
  the model draws a slab.
- **The outside** - not started. Google Solar for real roof planes, Elevation
  for terrain, a harder Street View read for the facade.

## The next thing to do

Build what the spec can already describe. The reading pass got ahead of the
geometry: a room can now report its worktop material, its door style and its
skirting profile, and `furniture.ts` will draw between one and three boxes for
each of them. Every improvement to the parts library improves every tour already
built, because furniture is derived and never stored - the same property that
made walls and windows cheap to get right.
