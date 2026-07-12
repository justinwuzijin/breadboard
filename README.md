# Breadboard

Interactive web breadboard simulator with CircuitJS schematic import/export, logic ICs, and a runnable Arduino Uno.

Built by [Justin Wu](https://www.justinzwu.com/) for ECE 192L prelab.

## Run

```bash
bun install
bun run dev
```

Open [http://localhost:8080](http://localhost:8080).

```bash
bun run build    # → dist/
bun run preview  # serve production build
```

## Deploy

Push to GitHub and connect to Vercel, or:

```bash
bun run build && npx vercel --prod
```

## Note

Vanilla JS (not React), served with Vite via Bun. The `circuitjs/` directory is Paul Falstad / Iain Sharp’s CircuitJS1 (GPL).
