# Legal notes

> This document is informational and is not legal advice. If you plan to distribute
> Gitora commercially or handle third-party data, consult a lawyer.

## License

Gitora is released under the **MIT License** ([LICENSE](../../LICENSE)): you may use, copy,
modify and distribute it, including commercially, keeping the copyright notice. The
software is provided "as is", without warranty of any kind.

Redistributed third-party components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Gitora does not bundle Git: it
runs the `git` already installed on the user's system as a separate process.

## Trademarks

Git, GitHub, GitLab, Bitbucket, Gitea, Forgejo, Codeberg, Windows, Linux and other names
used in the app and docs are trademarks of their respective owners, used only to indicate
compatibility (nominative use). **Gitora is an independent project and is not affiliated
with, sponsored by or endorsed by any of them.**

## Privacy and data

- Gitora has **no telemetry or analytics** and sends no data to the author's servers.
  (Checked in the code on 12 Nov 2026: the only network connections are the ones the user
  triggers against their own Git provider, e.g. `api.github.com`, `gitlab.com`.)
- Account credentials (tokens, passwords) are stored encrypted with the operating system
  store (Electron `safeStorage`) on the user's machine. If the system offers no
  encryption, they are not saved.
- Repositories and their data stay on the user's machine.
- The author collects no personal data and therefore does not act as controller or
  processor of the application users' data.

## Contact

Legal questions or takedown requests: mg230886@gmail.com.
