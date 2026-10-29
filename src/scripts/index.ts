/**
 * The main source file. Does only include {@link MainController}, which does the actual work.
 */

import { MainController } from "./internal"
import { initializeAgent } from "./controllers/agentController"

// @ts-ignore
window.mainController = MainController.instance
initializeAgent(MainController.instance)
