# pi-packages

Custom extensions for [pi](https://github.com/badlogic/pi-mono), the AI coding agent.

Pi packages can include extensions, skills, prompt templates, and themes. See the [pi packages docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) for details.

## Packages

| Package | Description |
|---------|-------------|
| [@dsshap/pi-loader-with](./packages/pi-loader-with/) | `--with` loader — load Pi extensions by short name and honor their `pi.prompts` / `pi.skills` manifest entries |
| [@dsshap/pi-pi-experts](./packages/pi-pi-experts/) | Pi Pi — meta-agent that builds Pi agents using a team of parallel research experts |
| [@dsshap/pi-agent-chain](./packages/pi-agent-chain/) | Agent Chain — sequential pipeline orchestrator for opinionated, repeatable multi-agent workflows |
| [@dsshap/pi-grid-manager](./packages/pi-grid-manager/) | UI middleware that composes `ui.setWidget()` calls from other extensions into a single side-by-side grid widget (`/grid <N>`) |
| [@dsshap/pi-gh](./packages/pi-gh/) | GitHub PR prompts (`/pr`, `/triage-pr-feedback`) and a `/gh` diagnostic command |


Each package has its own README with setup instructions, usage, and configuration details.

## Install All

Install every package in this repo with a single command:

```bash
pi install git:github.com/dsshap/pi-packages
```

Or try without installing:

```bash
pi -e git:github.com/dsshap/pi-packages
```

## Install One Package

Install a single package via npm:

```bash
pi install npm:@dsshap/<package-name>
```

<details>
<summary>Install commands by package</summary>

```bash
pi install npm:@dsshap/pi-loader-with
pi install npm:@dsshap/pi-pi-experts
pi install npm:@dsshap/pi-agent-chain
pi install npm:@dsshap/pi-grid-manager
pi install npm:@dsshap/pi-gh

```

</details>

## Internal Libraries

Workspace-internal helper packages used by the extensions above. **Not Pi extensions** — do not install with `pi install`. They are pulled in automatically as transitive npm dependencies when you install the consuming extension.

| Package | Description |
|---------|-------------|
| [@dsshap/pi-subagent-flags](./libraries/pi-subagent-flags/) | Shared helper that lets local users splice extra `pi` flags into every sub-agent subprocess spawn from a named extension. Consumed by `pi-pi-experts` and `pi-agent-chain`. |

Listed here for contributor reference. End users never need to install or configure these directly.

## Uninstall

If installed via git:

```bash
pi remove git:github.com/dsshap/pi-packages
```

If installed individually via npm:

```bash
pi remove npm:@dsshap/<package-name>
```

## Contributing

Each package under `packages/` is independent with its own `package.json`. There is no shared build system — each package is self-contained.

### Testing locally

```bash
cd packages/<package-name>
pi -e .
```

## License

MIT
