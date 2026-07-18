# AGENTS.md

## Core Principles

- **DESIGN AND BUILD PRODUCTION GRADE CODE FROM THE START** - i.e. no monolithic files if they should be  modularised, no unnecessary duplication of code, no hardcoded values if they can be placed in a centralised config file, etc.
- Keep AGENTS.md minimal - **only** keep information which will be required every time you look at this codebase. `Repository Structure` should **always** be kept up to date, and include a CONCISE single sentence description of each file in the project.  Do not modify `Core Principles`, but review and remove anything else from the document which is not required.
- Do **not** make assumptions without testing and validating first. Follow the scientific method.
- Write the bare minimum of tests - follow **ARRANGE, ACT, ASSERT**. You must test the end result, NOT the implmentation details.
- Use mocks for testing sparingly - if the code requires excessive mocking, then redesign the implementation to be easier to test.
- **You must assume that your knowledge is outdated** - always research topics and frameworks before making decisions.

## Important Notes

### Project Structure
