# Third-party notices

`src/browser-control/` is derived from the locally supplied clone of
https://github.com/nanobrowser/nanobrowser (package version 0.3.0, commit `6c4c0802a3967cb25e82f1249fcd68e79614c75f`),
licensed under Apache-2.0. Original comments are retained. The license is
in `public/NANOBROWSER-LICENSE.txt` and included in the extension.

Workbrowser modifications are identified in the modified files: URL matching
uses exact HTTP(S) origins and defaults to deny; tab access checks apply
the complete URL policy before observation or interaction.

Additional modifications: frame captures skip origins outside the administrator policy; target resolution rechecks the frame origin.

Policy changes also invalidate cached observations and known references so a narrowed policy takes effect on subsequent reads.

The Workbrowser agent in `src/agent/` was implemented with reference to
Nanobrowser's `src/agent/loop.ts`, `tools.ts`, `prompt.ts` and `guards.ts` at the
same supplied revision: observe/action/result turns, catalogue-derived tool
definitions, page-content boundaries, working context and progress guards.
Workbrowser uses its own Vue UI, local authenticated API and server-side Gemini
REST adapter. Explicit navigation may leave an unapproved or new-tab page;
destination policy still applies, and all reads check the current page.
