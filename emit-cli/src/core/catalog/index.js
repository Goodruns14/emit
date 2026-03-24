"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readCatalog = readCatalog;
exports.writeCatalog = writeCatalog;
exports.getEvent = getEvent;
exports.updateEvent = updateEvent;
exports.catalogExists = catalogExists;
const fs = __importStar(require("fs"));
const yaml = __importStar(require("js-yaml"));
function readCatalog(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Catalog file not found: ${filePath}\n` +
            "  Run `emit scan` first to generate the catalog.");
    }
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = yaml.load(content);
    if (!parsed || typeof parsed !== "object" || !parsed.events) {
        throw new Error(`Invalid catalog format: ${filePath}`);
    }
    return parsed;
}
function writeCatalog(filePath, catalog) {
    fs.writeFileSync(filePath, yaml.dump(catalog, { lineWidth: 120 }));
}
function getEvent(catalog, eventName) {
    return catalog.events[eventName];
}
function updateEvent(catalog, eventName, event) {
    return {
        ...catalog,
        events: {
            ...catalog.events,
            [eventName]: event,
        },
    };
}
function catalogExists(filePath) {
    return fs.existsSync(filePath);
}
//# sourceMappingURL=index.js.map