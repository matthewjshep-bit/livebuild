"use client";

/**
 * A room, or a house.
 *
 * Everything the app can do has been reached through one screen: you typed an
 * address, and whether you wanted a whole house or a single kitchen you got the
 * same house-shaped pipeline. Somebody with twelve photographs of one room had
 * to invent an address, accept a satellite trace of a building they may not
 * own, and then delete eight rooms they never asked for.
 *
 * So the first question is asked first. It is also the only screen here that
 * exists purely to route, which is why it is allowed to be big and to say what
 * each path needs rather than making that discoverable.
 */

export type BuildMode = "room" | "house";

/**
 * Drawn rather than lettered.
 *
 * The app uses emoji as icons in a few places and the UX standard it adopted
 * forbids it - they are inconsistent across platforms, they carry an implied
 * skin tone and mood, and a screen reader announces them. These are two shapes
 * that say the same thing without any of that.
 */
function RoomMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-9 w-9" aria-hidden fill="none">
      <rect x="8" y="12" width="32" height="26" rx="2" stroke="currentColor" strokeWidth="2.5" />
      <path d="M8 30h32" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      <circle cx="16" cy="34" r="1.6" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

function HouseMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-9 w-9" aria-hidden fill="none">
      <path d="M6 22 24 8l18 14" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M10 21v17h28V21" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M24 38V27h8v11" stroke="currentColor" strokeWidth="1.8" opacity="0.6" />
      <path d="M15 26h5v5h-5z" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
    </svg>
  );
}

function Card({
  mark,
  title,
  needs,
  gives,
  onClick,
  testId,
}: {
  mark: React.ReactNode;
  title: string;
  needs: string;
  gives: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="group flex-1 rounded-xl border border-ink-600 bg-ink-800 px-6 py-7 text-left transition hover:border-accent-dim hover:bg-ink-700"
    >
      <span className="text-accent transition group-hover:brightness-110">{mark}</span>
      <h2 className="mt-3 text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-mist-400">{gives}</p>
      <p className="mt-3 text-xs uppercase tracking-wide text-mist-400">Needs</p>
      <p className="mt-0.5 text-sm text-mist-200">{needs}</p>
    </button>
  );
}

export function ModeChoice({ onChoose }: { onChoose: (mode: BuildMode) => void }) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">What are you building?</h1>
      <p className="mt-2 text-sm leading-relaxed text-mist-400">
        Both give you a room you can walk through. They differ in how much you have to
        tell it first.
      </p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Card
          testId="mode-room"
          mark={<RoomMark />}
          title="A room"
          gives="One room, or a few connected ones, rebuilt from photographs. No address, no map, nothing to look up."
          needs="Photographs of the room"
          onClick={() => onChoose("room")}
        />
        <Card
          testId="mode-house"
          mark={<HouseMark />}
          title="A whole house"
          gives="Every room, laid out and joined up, with a scope of work priced against it."
          needs="Photographs, and an address if you have one"
          onClick={() => onChoose("house")}
        />
      </div>
    </div>
  );
}
