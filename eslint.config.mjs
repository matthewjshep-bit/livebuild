import { FlatCompat } from "@eslint/eslintrc";

/**
 * Lint, which until now was a script that could not run.
 *
 * `package.json` advertised `next lint`, nothing had ever installed ESLint, and
 * the command dropped into an interactive setup prompt - so it failed on a
 * terminal and hung on anything automated. Nine `eslint-disable-next-line`
 * comments sat in the source suppressing rules that were not being enforced,
 * which is the tell: somebody expected this to work.
 *
 * Next's own config, plus the type-aware rules, minus two whose defaults fight
 * this codebase rather than improve it - see below.
 */
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "pipeline/**", "public/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      /**
       * Unused is a warning, and an underscore means "deliberately".
       *
       * The three-argument callbacks React and three.js hand you are not a
       * defect, and neither is a destructured field kept for the shape.
       */
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    /**
     * The suites are scripts, not application code. They log by design, and the
     * browser ones evaluate closures that only make sense inside a page.
     */
    files: ["tools/**"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@next/next/no-img-element": "off",
    },
  },
];

export default config;
