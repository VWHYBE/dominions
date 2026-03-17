## Mobile Web Automation Integration Plan (MobAI + Dominions)

### 1. Goal

Give the Dominions agent the ability to **run and verify mobile web flows** (websites in mobile browsers on iOS and Android) by integrating with **MobAI**’s local HTTP API, while keeping the first iteration as a **proof of concept (PoC)** (no automatic execution yet).

### 2. MobAI – What We Use (Web Focus)

- **Desktop app** (MobAI) runs locally on macOS/Windows/Linux.
- Exposes a local **HTTP API** (base URL):  
  `http://127.0.0.1:8686/api/v1`
- Connects to real devices, emulators, or simulators (Android/iOS).
- Supports **mobile web automation** for Safari, Chrome, and WebViews.
- Provides a **DSL execution endpoint** for multi-step automation:
  - `POST /api/v1/devices/{id}/dsl/execute`
  - Request body (example):
    ```json
    {
      "version": "0.2",
      "steps": [
        { "action": "open_app", "bundle_id": "com.apple.Preferences" }
      ]
    }
    ```
- Same DSL runs on both **iOS and Android**, for actions like:
  - `open_app`, `tap`, `type`, `wait_for`, `assert_exists`, etc.

### 3. High-Level Architecture

- **Today**
  - Web UI → Express API → Agent Manager → [Minions] → (OpenRouter/Ollama) → memory.json

- **With MobAI PoC**
  - Web UI → Express API → Agent Manager → [Minions] →  
    - **LLM backend** (OpenRouter/Ollama)  
    - **Local tools** (`tools.js`) → **MobAI HTTP API** → connected mobile device

### 4. Integration Strategy (PoC)

#### 4.1. Design Principles

- **PoC-only**: define clean interfaces and wiring, but do not run MobAI yet.
- **Local-only**: communicate with MobAI over `localhost` HTTP, no remote services.
- **Composability**: add MobAI as another tool in `tools.js`, so any minion can call it.
- **LLM-driven scripts**: minions build DSL scripts from natural language, Dominions forwards them as-is to MobAI.

#### 4.2. New Client Module: `mobaiClient.js`

**Responsibility:** Thin, reusable wrapper around the MobAI HTTP API.

- Base URL:
  - Default: `http://127.0.0.1:8686/api/v1`
  - Override via `MOBAI_BASE_URL` in environment.

- Core helper:
  - `callMobai(path, { method, body })`
    - Builds URL: `MOBAI_BASE_URL + path`
    - Sends JSON request via `fetch`
    - Throws rich errors on non-2xx
    - Returns parsed JSON (or `null` if no JSON)

- Public functions:
  - `listDevices(): Promise<any>`
    - `GET /devices`
    - Returns connected devices with IDs and metadata.
  - `executeDsl(deviceId: string, script: { version: string; steps: any[] }): Promise<any>`
    - Validates `deviceId` and `script.steps`.
    - `POST /devices/{id}/dsl/execute` with full DSL payload.

#### 4.3. Extending `tools.js` for Minions

**Current tools:** `read_file`, `write_file`, `list_folder`.

**New tools for MobAI:**

- `mobai_list_devices`
  - Input: none.
  - Behavior:
    - Calls `listDevices()` from `mobaiClient.js`.
    - Returns `{ ok: true, devices }` on success.
    - Returns `{ ok: false, error }` on failure.

- `mobai_execute_dsl`
  - Input object:
    - `deviceId: string`
    - `script: { version: string; steps: any[] }`
  - Validation:
    - `deviceId` must be non-empty string.
    - `script.steps` must be an array.
  - Behavior:
    - Calls `executeDsl(deviceId, script)` from `mobaiClient.js`.
    - Returns `{ ok: true, result }` on success.
    - Returns `{ ok: false, error }` on failure.

These tools are **purely backend helpers**; they do not expose MobAI directly to the browser. Minions access MobAI only via the existing tool-calling mechanism.

### 5. Minion-Level Design (Mobile Runner)

#### 5.1. New Minion Concept: `mobile_runner`

**Role:** Turn high-level mobile web tasks into MobAI DSL scripts, execute them via tools, and report status/results back into the Dominions pipeline.

- Example ID: `"mobile_runner"`
- Example name: `"Mobile Runner"`
- Example system prompt (conceptual):

  > You are a Mobile Runner.  
  > Input: a natural language task and a known `deviceId`.  
  > 1. Design a MobAI DSL script (`version: "0.2"`, `steps[]`) that completes the task on the device.  
  > 2. Call the `mobai_execute_dsl` tool with `{ deviceId, script }`.  
  > 3. Inspect the tool result and return a concise status report and any errors or failed steps.

#### 5.2. Example Task Flow

- **User request (via Web UI or API):**
  - “On the iOS device, open Settings → Wi‑Fi screen and confirm Wi‑Fi section is visible.”

- **Minion behavior (conceptual):**
  1. Construct DSL script:
     ```json
     {
       "version": "0.2",
       "steps": [
         { "action": "open_app", "bundle_id": "com.apple.Preferences" },
         { "action": "tap", "label": "Wi‑Fi" },
         { "action": "wait_for", "text": "Wi‑Fi" },
         { "action": "assert_exists", "text": "Ask to Join Networks" }
       ]
     }
     ```
  2. Call `mobai_execute_dsl` with:
     ```json
     {
       "deviceId": "<some-device-id>",
       "script": { ...as above... }
     }
     ```
  3. Receive MobAI result (pass/fail info per step).
  4. Return a concise report into the Dominions pipeline, e.g.:
     - Success: “Wi‑Fi screen opened and assertion passed.”
     - Failure: “Step 2 tap ‘Wi‑Fi’ failed: element not found.”

#### 5.3. Pipeline Integration

- **Option 1 (separate stage):**
  - Add `mobile_runner` as a final minion in the existing chain (e.g. after `reviewer`), only for tasks that explicitly require mobile automation.

- **Option 2 (conditional):**
  - Planner decides whether to route to `mobile_runner` based on task text (e.g. keywords: “iOS”, “Android”, “phone”, “mobile app”).

For the PoC, we can keep the routing simple (explicit user opt-in) and focus on DSL + tool wiring.

### 6. Configuration & Environment

#### 6.1. Environment Variables

- Add to `.env.example` / `.env`:
  - `MOBAI_BASE_URL=http://127.0.0.1:8686/api/v1` (optional, has default).

#### 6.2. Requirements Outside Repo (User Actions)

To actually run mobile automation (after PoC is accepted), the user will need to:

1. **Install MobAI desktop app** from `https://mobai.run/`.
2. **Connect device** (physical or emulator/simulator) so MobAI sees it.
3. Ensure MobAI HTTP API is running on `127.0.0.1:8686`.
4. Obtain or confirm a valid `deviceId` (from MobAI UI or API).

### 7. What the PoC Includes vs Excludes

**Included in PoC (design + code changes):**

- `mobaiClient.js` with:
  - `listDevices()`
  - `executeDsl(deviceId, script)`
- New tools in `tools.js`:
  - `mobai_list_devices`
  - `mobai_execute_dsl`
- Optional new minion entry `mobile_runner` in `minions/config.json` (concept and schema).
- Optional README updates describing:
  - High-level MobAI integration.
  - Required environment variable(s).

**Not included yet (future execution phase):**

- Actually installing/running the MobAI desktop app.
- Real device connections and live test runs.
- Advanced flows (multi-device runs, parallel suites, screenshot pipelines).

### 8. Future Extensions (After PoC)

Once the PoC is validated, potential next steps:

- **Richer DSL generation:**
  - Auto-generate test cases for onboarding, payments, etc.
  - Use assertions and retries for more robust flows.

- **Screenshot & reporting:**
  - Capture screenshots for each major step.
  - Store in a dedicated artifacts directory and attach URLs/paths in Dominions responses.

- **Parallel devices:**
  - Run the same DSL on multiple device IDs (different OS versions / screen sizes).

- **MCP integration:**
  - Optionally also integrate MobAI via MCP (`npx mobai-mcp`) so Cursor can control mobile independently of Dominions when desired.

