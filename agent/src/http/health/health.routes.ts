import { Router } from "express";
import { getHealth } from "./health.handlers.js";

export const healthRoutes: Router = Router();

healthRoutes.get("/", getHealth);
