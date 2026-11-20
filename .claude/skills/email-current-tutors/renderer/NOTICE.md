# Bundled BeGifted email renderer

`company.mjs`, `company-render.mjs` and `render.mjs` are unmodified copies of the `begifted-design` skill's
`emails/runtime/` modules, release **3.2.0** (`assets/release.json`). Do not edit them here. To upgrade, copy the
three files again from a newer `begifted-design` release and rerun `node --test .claude/skills/email-current-tutors/build-email.test.mjs`.

The company templates adapt layouts from Colorlib's email templates
(https://github.com/ColorlibHQ/email-templates, revision `3018557fe943fb1c3e3367aa52d39b2fca44f725`). Their MIT
licence is reproduced verbatim in `LICENSE-colorlib-MIT.txt`. No upstream images, fonts or copy are bundled.
