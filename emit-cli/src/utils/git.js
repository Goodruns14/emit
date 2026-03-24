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
exports.getCurrentCommit = getCurrentCommit;
exports.getCatalogHistory = getCatalogHistory;
exports.getEventAtCommit = getEventAtCommit;
exports.isGitRepo = isGitRepo;
exports.getCatalogAtRef = getCatalogAtRef;
exports.getChangedFiles = getChangedFiles;
exports.getRelativeCatalogPath = getRelativeCatalogPath;
const child_process_1 = require("child_process");
const yaml = __importStar(require("js-yaml"));
function getCurrentCommit() {
    try {
        return (0, child_process_1.execSync)("git rev-parse --short HEAD", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    }
    catch {
        return "unknown";
    }
}
function getCatalogHistory(filePath) {
    try {
        const output = (0, child_process_1.execSync)(`git log --follow --format="%H|%ai|%s" -- "${filePath}"`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        if (!output)
            return [];
        return output
            .split("\n")
            .filter(Boolean)
            .slice(0, 20)
            .map((line) => {
            const [sha, date, ...msgParts] = line.split("|");
            return {
                sha: sha.slice(0, 8),
                date: date.slice(0, 10),
                message: msgParts.join("|").slice(0, 80),
            };
        });
    }
    catch {
        return [];
    }
}
function getEventAtCommit(catalogFile, eventName, sha) {
    try {
        const content = (0, child_process_1.execSync)(`git show "${sha}:${catalogFile}"`, {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const catalog = yaml.load(content);
        return catalog?.events?.[eventName] ?? null;
    }
    catch {
        return null;
    }
}
function isGitRepo(cwd) {
    try {
        (0, child_process_1.execSync)("git rev-parse --git-dir", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            cwd: cwd ?? process.cwd(),
        });
        return true;
    }
    catch {
        return false;
    }
}
function getCatalogAtRef(ref, catalogPath) {
    try {
        const content = (0, child_process_1.execSync)(`git show "${ref}:${catalogPath}"`, {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const parsed = yaml.load(content);
        return parsed?.events ? parsed : null;
    }
    catch {
        return null;
    }
}
function getChangedFiles(baseRef) {
    try {
        const output = (0, child_process_1.execSync)(`git diff --name-only "${baseRef}...HEAD"`, {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (!output)
            return [];
        return output.split("\n").filter(Boolean);
    }
    catch {
        return [];
    }
}
function getRelativeCatalogPath(absolutePath) {
    try {
        const root = (0, child_process_1.execSync)("git rev-parse --show-toplevel", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return absolutePath.startsWith(root)
            ? absolutePath.slice(root.length + 1)
            : absolutePath;
    }
    catch {
        return absolutePath;
    }
}
//# sourceMappingURL=git.js.map