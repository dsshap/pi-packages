# pi-packages

Custom extensions for [pi](https://github.com/badlogic/pi-mono), the AI coding agent.

Pi packages can include extensions, skills, prompt templates, and themes. See the [pi packages docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) for details.

## Packages

| Package | Type | Description |
|---------|------|-------------|
| [@dsshap/pi-pi-experts](./packages/pi-pi-experts/) | Extension | Pi Pi — meta-agent that builds Pi agents using a team of parallel research experts |

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
pi install npm:@dsshap/pi-pi-experts
```

</details>

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
