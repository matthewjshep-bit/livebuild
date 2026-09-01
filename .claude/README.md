# Skills

## ui-ux-pro-max

Vendored from [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
at `d279284`, MIT licensed, licence kept alongside it.

Searchable UI/UX guidance — 119 UX guidelines, style and colour catalogues, font
pairings, per-stack notes. Query it directly:

```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain ux
```

Copied in rather than installed through its `npm install -g ui-ux-pro-max-cli`,
so there is no global binary and the exact version in use is the one committed
here. Python 3, standard library only — no dependencies to install, and nothing
in it reaches the network.

### What it is good for here, and what it is not

The **UX guidelines** are the useful part: they are objective, stack-agnostic,
and they found real defects in this app — every form input had its focus ring
removed with no replacement, and nothing anywhere honoured
`prefers-reduced-motion`.

The **`--design-system` generator is aimed at greenfield marketing pages** and
should be ignored for this project. Asked about Livebuild.ai it proposed a
hero-centric glassmorphism landing page, a light teal palette and Cinzel — for a
dark full-bleed tool whose main screens are a plan editor and a 3D walkthrough.
It is answering a different question than the one this codebase asks. Use the
`--domain ux` searches; leave the palette and typography alone.

Treat results as recommendations. The skill's own SKILL.md says the same:
they never override the repository's existing conventions.
