// src/renderer/workbench/contrib/files/browser/tree/fileIcons.ts — a minimal inline SVG icon
// set (delta: the real workbench resolves icons through file-icon-theme contributions; the
// course ships fixed shapes and per-extension colors).

const EXTENSION_COLORS: Record<string, string> = {
	ts: '#519aba',
	js: '#cbcb41',
	json: '#cbcb41',
	md: '#519aba',
	html: '#e37933',
	css: '#519aba',
	txt: '#cccccc'
};

function extensionOf(name: string): string {
	const index = name.lastIndexOf('.');
	return index > 0 ? name.substring(index + 1).toLowerCase() : '';
}

const FILE_ICON = '<svg viewBox="0 0 16 16"><path d="M9.5 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V4.5L9.5 1zM9 5V2l3 3H9z"/></svg>';
const FOLDER_ICON = '<svg viewBox="0 0 16 16"><path d="M1.5 3a1 1 0 011-1h3.6l1.4 1.5h6a1 1 0 011 1V12a1 1 0 01-1 1h-11a1 1 0 01-1-1V3z"/></svg>';
const FOLDER_OPEN_ICON = '<svg viewBox="0 0 16 16"><path d="M1.5 3a1 1 0 011-1h3.6l1.4 1.5h6a1 1 0 011 1V6H2.8L1.5 12.2V3z"/><path d="M2.6 7h12.2l-1.6 5.2a1 1 0 01-.96.8H1.6L2.6 7z"/></svg>';

/** returns the icon markup + the color to apply */
export function fileIcon(name: string, isDirectory: boolean, expanded: boolean): { svg: string; color: string } {
	if (isDirectory) {
		return { svg: expanded ? FOLDER_OPEN_ICON : FOLDER_ICON, color: '#90a4ae' };
	}
	const extension = extensionOf(name);
	return { svg: FILE_ICON, color: EXTENSION_COLORS[extension] ?? '#cccccc' };
}
