<!-- Destination: a community "Show Your Plugins" / plugin release thread, posted
     from the dsh-searxng maintainer's account — the adopter voice, complementing
     dsh-vet's own announcements. Facts verified against the live report on
     dsh-searxng's dsh-vet/report branch (grade A, scanner 0.2.6) and the
     0.1.0-era first audit (grade C, committed in dsh-vet's examples/). -->

**dsh-searxng** — free, self-hosted web search for DeepSeek Harness, with its
security audit public on every push.

What it is: a DSH plugin that adds a SearXNG-backed `web_search` provider on
the `ctx.web` seam — self-hosted, key-less search instead of paid
Exa/Perplexity APIs.

A search plugin exists to open network connections — which is exactly why I
think it should declare what it touches and prove it continuously. Here's
the arc, because the middle part is the interesting one:

- **First audit: grade C.** Fair catch — the plugin opened network
  connections without declaring the `web` seam anywhere. One medium finding,
  `perm.network-client`, with the evidence attached.
- **The fix was declaring intent, not gaming the scanner:** one line in
  package.json — `"dsh": { "seams": ["web", "fs", "shell"] }` — saying what
  the plugin actually touches.
- **CI wired in:** one GitHub Action step ([rogerdigital/dsh-vet](https://github.com/rogerdigital/dsh-vet))
  audits every push. The README badge reads from the report committed in my
  own repo, so its value is auditable through my git history — no badge
  service deciding what my plugin's grade is.
- **Current grade: A, with the leftovers still shown.** The live report
  still carries one low-confidence finding (a runtime-value fs write the
  scanner honestly can't statically scope) and one info note. That's the
  true state — a low-confidence signal never lowers a grade, by contract,
  and I'd rather you see it than not.

If you write DSH plugins: this took about ten minutes (declare your seams +
one workflow step), and "what does this plugin touch?" now has a
machine-readable answer instead of trust-me.

Repo: [rogerdigital/dsh-searxng](https://github.com/rogerdigital/dsh-searxng) —
badge in the README, full report on the `dsh-vet/report` branch.
