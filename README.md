# breadboard

![breadboard demo](public/img/demo.png)

An interactive web breadboard with CircuitJS schematic import/export.

Transforms Falstad circuit diagrams into a functioning breadboard layout — built to speed up SYDE 192L lab work.

## Setup

```bash
bun install && bun run dev
```

Open [http://localhost:8080](http://localhost:8080). Build with `bun run build`.

## Project layout

```
├── index.html          # Vite entry
├── src/                # app modules (JS + CSS)
├── public/             # static assets (served as-is)
│   ├── img/            # part photos, favicon
│   ├── audio/
│   ├── examples/       # Arduino sketch samples
│   ├── circuits/       # sample Lab 4 CircuitJS dumps
│   └── circuitjs/      # self-hosted CircuitJS1 (GPL)
├── vite.config.js
└── package.json
```

## Arduino

Drop an Arduino Uno from the parts palette, wire power/GND, write a sketch in the inspector, and upload. Sample sketches live in `public/examples/`.

## License note

`public/circuitjs/` is Paul Falstad / Iain Sharp’s CircuitJS1 (GPL).
