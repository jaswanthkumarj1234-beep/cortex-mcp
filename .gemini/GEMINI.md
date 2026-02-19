# Cortex Memory Rules — MANDATORY

## At Conversation Start (ALWAYS)
1. ALWAYS call `mcp_cortex_force_recall` with the topic of the user's question  
   - This returns ALL corrections, decisions, conventions, and bug fixes
   - Plus topic-specific search results
   - DO NOT skip this step. It is mandatory.

## After EVERY Response (ALWAYS)
2. ALWAYS call `mcp_cortex_auto_learn` with the text of your response  
   - Cortex will automatically extract and store any decisions, corrections, conventions, or bug fixes
   - This is how Cortex learns passively — zero manual effort required
   - DO NOT skip this step. It is mandatory.
   - Example: `mcp_cortex_auto_learn(text: "We decided to use PostgreSQL instead of MongoDB because...")`

## When Decisions Are Made (Manual Override)
ALSO call `mcp_cortex_store_memory` for high-importance items:
- A critical architectural decision (type: DECISION)
- A mistake that must never be repeated (type: CORRECTION)  
- A project-wide coding convention (type: CONVENTION)
- A tricky bug that was hard to find (type: BUG_FIX)

## Before Suggesting Code
Call `mcp_cortex_verify_code` to check:
- Are import packages real (exist in package.json)?
- Are imported functions actually exported?
- Are env variables defined in .env?

## Before Referencing Files
Call `mcp_cortex_verify_files` to check if file paths are real.
