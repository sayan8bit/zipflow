// --- PWA Service Worker Registration ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => console.log('Service Worker registered successfully.', reg.scope))
      .catch((err) => console.warn('Service Worker registration failed.', err));
  });
}

// --- App State ---
let currentZip = null;
let zipFileName = '';
let rootNode = null; 
let flatNodesList = []; 
let selectedFilesCount = 0;
let currentSearchQuery = '';
let currentFilter = 'all';
let currentPreviewNode = null;

// --- UI Elements ---
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadSection = document.getElementById('upload-section');
const explorerSection = document.getElementById('explorer-section');
const closeZipBtn = document.getElementById('close-zip-btn');
const zipNameEl = document.getElementById('zip-name');
const statFilesEl = document.getElementById('stat-files');
const statSizeEl = document.getElementById('stat-size');
const statCompSizeEl = document.getElementById('stat-comp-size');
const statRatioEl = document.getElementById('stat-ratio');
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');
const filterTagsContainer = document.getElementById('filter-tags-container');
const selectionCountEl = document.getElementById('selection-count');
const selectAllBtn = document.getElementById('select-all-btn');
const selectNoneBtn = document.getElementById('select-none-btn');
const treeContainer = document.getElementById('tree-container');
const noResultsEl = document.getElementById('no-results');
const headerSelectAll = document.getElementById('header-select-all');

const downloadSelectedUnzippedBtn = document.getElementById('download-selected-unzipped-btn');

// Floating Bottom Drawer Elements
const selectionDrawer = document.getElementById('selection-drawer');
const drawerCount = document.getElementById('drawer-count');
const drawerDownloadBtn = document.getElementById('drawer-download-btn');

// Overlays & Modals
const loadingOverlay = document.getElementById('loading-overlay');
const loadingTitle = document.getElementById('loading-title');
const loadingMessage = document.getElementById('loading-message');
const loadingProgress = document.getElementById('loading-progress');

const previewModal = document.getElementById('preview-modal');
const previewFilename = document.getElementById('preview-filename');
const previewFilesize = document.getElementById('preview-filesize');
const previewIcon = document.getElementById('preview-icon');
const previewBody = document.getElementById('preview-body');
const previewDownloadBtn = document.getElementById('preview-download-btn');
const closePreviewBtn = document.getElementById('close-preview-btn');
const previewPrevBtn = document.getElementById('preview-prev-btn');
const previewNextBtn = document.getElementById('preview-next-btn');
const previewCounter = document.getElementById('preview-counter');

const installBtn = document.getElementById('install-btn');

// --- PWA Installation Event ---
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') {
    installBtn.classList.add('hidden');
  }
  deferredPrompt = null;
});

// --- Tree Node Class ---
class TreeNode {
  constructor(name, path, isDirectory = false) {
    this.name = name;
    this.path = path;
    this.isDirectory = isDirectory;
    this.size = 0;
    this.compressedSize = 0;
    this.children = [];
    this.parent = null;
    this.expanded = true;
    this.selected = false; // true, false, or 'indeterminate'
    this.jszipEntry = null; // JSZip file object
  }

  get isFile() {
    return !this.isDirectory;
  }
}

// --- Drag & Drop Handlers ---
window.addEventListener('dragenter', (e) => e.preventDefault());
window.addEventListener('dragover', (e) => e.preventDefault());

window.addEventListener('drop', (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  const files = dt.files;
  if (files && files.length > 0) {
    if (files[0].name.endsWith('.zip')) {
      handleZipFile(files[0]);
    } else {
      showToast('Please upload a valid ZIP file.', 'error');
    }
  }
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', () => {
  dropzone.classList.remove('dragover');
});

fileInput.addEventListener('change', (e) => {
  const files = e.target.files;
  if (files.length > 0) {
    handleZipFile(files[0]);
  }
});

// Reset application to upload state
closeZipBtn.addEventListener('click', () => {
  currentZip = null;
  zipFileName = '';
  rootNode = null;
  flatNodesList = [];
  selectedFilesCount = 0;
  fileInput.value = '';
  
  selectionDrawer.classList.add('hidden-drawer');
  
  headerSelectAll.checked = false;
  headerSelectAll.indeterminate = false;
  
  explorerSection.classList.remove('active');
  uploadSection.classList.add('active');
  searchInput.value = '';
  searchClearBtn.classList.add('hidden');
  currentSearchQuery = '';
  currentFilter = 'all';
  
  // Reset filters UI
  document.querySelectorAll('.filter-tag').forEach(tag => tag.classList.remove('active'));
  document.querySelector('[data-filter="all"]').classList.add('active');
});

// --- ZIP Parsing Logic ---
async function handleZipFile(file) {
  zipFileName = file.name;
  zipNameEl.textContent = zipFileName;
  
  showLoading('Loading Archive', 'Reading ZIP file structure...', 10);
  
  try {
    const reader = new FileReader();
    reader.onload = async function(e) {
      try {
        updateLoadingProgress(40, 'Parsing directories...');
        const arrayBuffer = e.target.result;
        currentZip = await JSZip.loadAsync(arrayBuffer);
        
        buildTree();
        updateLoadingProgress(90, 'Preparing explorer view...');
        
        // Render Explorer
        renderTree();
        updateStats();
        updateSelectionStatus();
        
        uploadSection.classList.remove('active');
        explorerSection.classList.add('active');
        hideLoading();
        showToast('ZIP file parsed successfully.', 'success');
      } catch (err) {
        console.error(err);
        hideLoading();
        showToast('Error parsing ZIP file. The archive might be corrupted.', 'error');
      }
    };
    reader.onerror = function() {
      hideLoading();
      showToast('Error reading ZIP file from disk.', 'error');
    };
    reader.readAsArrayBuffer(file);
  } catch (err) {
    hideLoading();
    showToast('An unexpected error occurred.', 'error');
  }
}

// Build hierarchical directory tree from flat list of ZIP file paths
function buildTree() {
  rootNode = new TreeNode('root', '', true);
  flatNodesList = [];
  
  const entries = Object.values(currentZip.files);
  
  entries.forEach(entry => {
    // Standardize path: replace backslashes and remove trailing slash
    const cleanPath = entry.name.replace(/\\/g, '/').replace(/\/$/, '');
    if (!cleanPath) return; // skip empty entries
    
    const parts = cleanPath.split('/');
    let currentNode = rootNode;
    let currentPath = '';
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      
      const isLastPart = (i === parts.length - 1);
      const isDir = entry.dir || (!isLastPart);
      
      // Find if child already exists
      let child = currentNode.children.find(c => c.name === part && c.isDirectory === isDir);
      
      if (!child) {
        child = new TreeNode(part, currentPath, isDir);
        child.parent = currentNode;
        currentNode.children.push(child);
        flatNodesList.push(child);
      }
      
      // If it is the actual entry file, map metadata
      if (isLastPart && !entry.dir) {
        child.size = entry._data ? entry._data.uncompressedSize : 0;
        child.compressedSize = entry._data ? entry._data.compressedSize : 0;
        child.jszipEntry = entry;
      }
      
      currentNode = child;
    }
  });

  // Calculate directory sizes recursively
  calculateDirectoryStats(rootNode);
  
  // Sort children alphabetically, directories first
  sortTree(rootNode);
}

function calculateDirectoryStats(node) {
  if (node.isFile) return { size: node.size, compSize: node.compressedSize };
  
  let totalSize = 0;
  let totalCompSize = 0;
  
  node.children.forEach(child => {
    const stats = calculateDirectoryStats(child);
    totalSize += stats.size;
    totalCompSize += stats.compSize;
  });
  
  node.size = totalSize;
  node.compressedSize = totalCompSize;
  return { size: totalSize, compSize: totalCompSize };
}

function sortTree(node) {
  if (!node.children || node.children.length === 0) return;
  
  node.children.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  
  node.children.forEach(sortTree);
}

// --- Tree UI Rendering Logic ---
function renderTree() {
  treeContainer.innerHTML = '';
  
  if (rootNode.children.length === 0) {
    noResultsEl.classList.remove('hidden');
    return;
  }
  
  noResultsEl.classList.add('hidden');
  const frag = document.createDocumentFragment();
  
  // Recursive preorder tree rendering based on expand state, search, and filters
  function traverseAndRender(node, depth = 0) {
    if (node === rootNode) {
      node.children.forEach(child => traverseAndRender(child, depth));
      return;
    }

    const matchesSearch = checkSearchMatch(node);
    const matchesFilter = checkFilterMatch(node);
    
    // Determine visibility
    let isVisible = true;
    
    if (currentSearchQuery) {
      isVisible = matchesSearch;
    } else if (currentFilter !== 'all') {
      isVisible = matchesFilter;
    }
    
    if (!isVisible) return;

    // Create the row element
    const row = document.createElement('div');
    row.className = `tree-row ${node.isDirectory ? 'directory' : 'file'}`;
    if (node.selected === true) row.classList.add('selected');
    row.dataset.path = node.path;
    
    // Checkbox col
    const colCheck = document.createElement('div');
    colCheck.className = 'col-checkbox';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'custom-checkbox';
    if (node.selected === true) {
      chk.checked = true;
    } else if (node.selected === 'indeterminate') {
      chk.indeterminate = true;
    }
    chk.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleNodeSelection(node, chk.checked);
    });
    colCheck.appendChild(chk);
    row.appendChild(colCheck);
    
    // Content layout (Indent + Name + Icon)
    const content = document.createElement('div');
    content.className = 'tree-row-content';
    content.style.paddingLeft = `${depth * 1.5}rem`;
    
    // Expander Icon for Directory
    const expander = document.createElement('span');
    expander.className = 'expander-icon';
    if (node.isDirectory) {
      expander.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      `;
      if (node.expanded) expander.classList.add('expanded');
      expander.addEventListener('click', (e) => {
        e.stopPropagation();
        node.expanded = !node.expanded;
        renderTree();
      });
    } else {
      expander.classList.add('hidden-expander');
    }
    content.appendChild(expander);
    
    // File Type Icon
    const typeIcon = document.createElement('span');
    typeIcon.className = `file-type-icon ${getFileCategory(node.name)}`;
    typeIcon.innerHTML = getFileTypeSVG(node.isDirectory, node.name);
    content.appendChild(typeIcon);
    
    // Filename
    const nameSpan = document.createElement('span');
    nameSpan.className = 'row-filename';
    nameSpan.textContent = node.name;
    content.appendChild(nameSpan);
    
    // Toggle expand or preview on row-content click
    content.addEventListener('click', () => {
      if (node.isDirectory) {
        node.expanded = !node.expanded;
        renderTree();
      } else {
        triggerPreview(node);
      }
    });
    row.appendChild(content);
    
    // Size Col
    const colSize = document.createElement('div');
    colSize.className = 'col-size row-size';
    colSize.textContent = node.isDirectory ? '-' : formatBytes(node.size);
    row.appendChild(colSize);
    
    // Compressed Size Col
    const colComp = document.createElement('div');
    colComp.className = 'col-comp-size row-comp-size';
    colComp.textContent = node.isDirectory ? '-' : formatBytes(node.compressedSize);
    row.appendChild(colComp);
    
    // Actions Col
    const colActions = document.createElement('div');
    colActions.className = 'col-actions tree-row-actions';
    
    if (node.isFile) {
      // Preview Button
      const previewBtn = document.createElement('button');
      previewBtn.className = 'tree-row-btn';
      previewBtn.title = 'Preview File';
      previewBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      `;
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerPreview(node);
      });
      colActions.appendChild(previewBtn);
      
      // Download Button
      const dlBtn = document.createElement('button');
      dlBtn.className = 'tree-row-btn btn-row-download';
      dlBtn.title = 'Download unzipped';
      dlBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      `;
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadSingleFile(node);
      });
      colActions.appendChild(dlBtn);
    }
    
    row.appendChild(colActions);
    frag.appendChild(row);
    
    // Recurse for children if directory and expanded (or if searching/filtering where we want to keep them visible)
    if (node.isDirectory) {
      if (node.expanded || currentSearchQuery || currentFilter !== 'all') {
        node.children.forEach(child => traverseAndRender(child, depth + 1));
      }
    }
  }
  
  traverseAndRender(rootNode);
  treeContainer.appendChild(frag);
  
  syncHeaderCheckbox();
}

// Check if search pattern matches node or its children
function checkSearchMatch(node) {
  if (!currentSearchQuery) return true;
  const q = currentSearchQuery.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.isDirectory) {
    return node.children.some(child => checkSearchMatch(child));
  }
  return false;
}

// Check if filter pattern matches node category
function checkFilterMatch(node) {
  if (currentFilter === 'all') return true;
  if (node.isFile) {
    const cat = getFileCategory(node.name);
    if (currentFilter === 'audio-video') {
      return cat === 'audio' || cat === 'video';
    }
    return cat === currentFilter;
  }
  if (node.isDirectory) {
    return node.children.some(child => checkFilterMatch(child));
  }
  return false;
}

// File Category Detector
function getFileCategory(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  
  const categories = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'tiff', 'bmp'],
    code: ['txt', 'md', 'js', 'css', 'html', 'json', 'xml', 'py', 'go', 'java', 'c', 'cpp', 'h', 'ts', 'sql', 'sh', 'bat', 'yml', 'yaml', 'ini', 'conf'],
    pdf: ['pdf'],
    audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
    video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv'],
    archive: ['zip', 'rar', 'tar', 'gz', '7z', 'bz2']
  };
  
  for (const [key, extensions] of Object.entries(categories)) {
    if (extensions.includes(ext)) return key;
  }
  return 'default';
}

function getFileTypeSVG(isDir, filename) {
  if (isDir) {
    return `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>
    `;
  }
  
  const cat = getFileCategory(filename);
  switch (cat) {
    case 'image':
      return `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      `;
    case 'code':
      return `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 18 22 12 16 6"></polyline>
          <polyline points="8 6 2 12 8 18"></polyline>
        </svg>
      `;
    case 'pdf':
      return `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
      `;
    case 'audio':
      return `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
      `;
    case 'video':
      return `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="23 7 16 12 23 17 23 7"></polygon>
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
        </svg>
      `;
    case 'archive':
      return `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"></polyline>
          <rect x="1" y="3" width="22" height="5" rx="1"></rect>
          <line x1="10" y1="12" x2="14" y2="12"></line>
        </svg>
      `;
    default:
      return `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
      `;
  }
}

// --- Selection Cascade Logic ---
function toggleNodeSelection(node, isSelected) {
  function cascadeDown(n, val) {
    n.selected = val;
    if (n.isDirectory) {
      n.children.forEach(child => cascadeDown(child, val));
    }
  }
  cascadeDown(node, isSelected);

  function cascadeUp(n) {
    if (!n || n === rootNode) return;
    const parent = n.parent;
    if (!parent) return;

    const allChecked = parent.children.every(c => c.selected === true);
    const allUnchecked = parent.children.every(c => c.selected === false);

    if (allChecked) {
      parent.selected = true;
    } else if (allUnchecked) {
      parent.selected = false;
    } else {
      parent.selected = 'indeterminate';
    }

    cascadeUp(parent);
  }
  cascadeUp(node);

  renderTree();
  updateSelectionStatus();
}

function updateSelectionStatus() {
  let count = 0;
  
  function countFiles(node) {
    if (node.isFile && node.selected === true) {
      count++;
    }
    if (node.isDirectory) {
      node.children.forEach(countFiles);
    }
  }
  if (rootNode) countFiles(rootNode);
  
  selectedFilesCount = count;
  
  const labelText = `${count} ${count === 1 ? 'file' : 'files'} selected`;
  selectionCountEl.textContent = labelText;
  drawerCount.textContent = labelText;
  
  if (count > 0) {
    downloadSelectedUnzippedBtn.classList.remove('disabled');
    selectionDrawer.classList.remove('hidden-drawer');
  } else {
    downloadSelectedUnzippedBtn.classList.add('disabled');
    selectionDrawer.classList.add('hidden-drawer');
  }
}

function syncHeaderCheckbox() {
  if (!rootNode || rootNode.children.length === 0) {
    headerSelectAll.checked = false;
    headerSelectAll.indeterminate = false;
    return;
  }

  const allChecked = rootNode.children.every(c => c.selected === true);
  const allUnchecked = rootNode.children.every(c => c.selected === false);

  if (allChecked) {
    headerSelectAll.checked = true;
    headerSelectAll.indeterminate = false;
  } else if (allUnchecked) {
    headerSelectAll.checked = false;
    headerSelectAll.indeterminate = false;
  } else {
    headerSelectAll.checked = false;
    headerSelectAll.indeterminate = true;
  }
}

// Master Header Checkbox Handler
headerSelectAll.addEventListener('change', () => {
  const isChecked = headerSelectAll.checked;
  rootNode.children.forEach(child => toggleNodeSelection(child, isChecked));
});

// Selection Action Buttons
selectAllBtn.addEventListener('click', () => {
  rootNode.children.forEach(child => toggleNodeSelection(child, true));
});

selectNoneBtn.addEventListener('click', () => {
  rootNode.children.forEach(child => toggleNodeSelection(child, false));
});

// --- Search and Filters ---
searchInput.addEventListener('input', () => {
  currentSearchQuery = searchInput.value;
  if (currentSearchQuery) {
    searchClearBtn.classList.remove('hidden');
  } else {
    searchClearBtn.classList.add('hidden');
  }
  renderTree();
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  currentSearchQuery = '';
  searchClearBtn.classList.add('hidden');
  renderTree();
});

filterTagsContainer.addEventListener('click', (e) => {
  if (e.target.classList.contains('filter-tag')) {
    document.querySelectorAll('.filter-tag').forEach(tag => tag.classList.remove('active'));
    e.target.classList.add('active');
    currentFilter = e.target.dataset.filter;
    renderTree();
  }
});

// --- Download Operations ---

function getSelectedFiles(node, list = []) {
  if (node.isFile && node.selected === true) {
    list.push(node);
  }
  if (node.isDirectory) {
    node.children.forEach(child => getSelectedFiles(child, list));
  }
  return list;
}

async function downloadSingleFile(node) {
  if (!node.jszipEntry) return;
  showLoading('Extracting File', `Decompressing ${node.name}...`, 20);
  try {
    const blob = await node.jszipEntry.async('blob');
    triggerBlobDownload(blob, node.name);
    hideLoading();
    showToast(`Successfully extracted ${node.name}`, 'success');
  } catch (err) {
    console.error(err);
    hideLoading();
    showToast(`Failed to extract ${node.name}`, 'error');
  }
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// Batch download selected files unzipped
downloadSelectedUnzippedBtn.addEventListener('click', async () => {
  const selectedFiles = getSelectedFiles(rootNode);
  if (selectedFiles.length === 0) return;

  showLoading('Extracting Selected Files', `Preparing to decompress ${selectedFiles.length} files...`, 5);

  if (selectedFiles.length > 2) {
    showToast('Extracting files sequentially. Please allow multiple file downloads if prompted.', 'warning');
  }

  try {
    for (let i = 0; i < selectedFiles.length; i++) {
      const node = selectedFiles[i];
      const percent = Math.round(((i + 1) / selectedFiles.length) * 100);
      updateLoadingProgress(percent, `Decompressing ${node.name}...`);
      
      const blob = await node.jszipEntry.async('blob');
      triggerBlobDownload(blob, node.name);
      
      if (selectedFiles.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    hideLoading();
    showToast(`Successfully extracted ${selectedFiles.length} files.`, 'success');
  } catch (err) {
    console.error(err);
    hideLoading();
    showToast('An error occurred during multi-file extraction.', 'error');
  }
});

// Drawer Button Listeners
drawerDownloadBtn.addEventListener('click', () => {
  if (selectedFilesCount > 0) {
    downloadSelectedUnzippedBtn.click();
  }
});

// --- Preview Modal Logic ---
let activePreviewBlobUrl = null;

// Get all files matching search/filter in tree order
function getPreviewableFiles() {
  const files = [];
  function traverse(node) {
    if (node.isFile) {
      const matchesSearch = checkSearchMatch(node);
      const matchesFilter = checkFilterMatch(node);
      let isVisible = true;
      if (currentSearchQuery) {
        isVisible = matchesSearch;
      } else if (currentFilter !== 'all') {
        isVisible = matchesFilter;
      }
      if (isVisible) {
        files.push(node);
      }
    } else if (node.isDirectory) {
      node.children.forEach(traverse);
    }
  }
  if (rootNode) traverse(rootNode);
  return files;
}

// Update Prev/Next button states and the slide counter
function updatePreviewNavButtons(index, total) {
  if (total <= 1) {
    previewPrevBtn.classList.add('hidden');
    previewNextBtn.classList.add('hidden');
    previewCounter.textContent = '';
  } else {
    previewPrevBtn.classList.remove('hidden');
    previewNextBtn.classList.remove('hidden');
    previewCounter.textContent = `${index + 1} / ${total}`;
    
    previewPrevBtn.disabled = (index === 0);
    previewNextBtn.disabled = (index === total - 1);
  }
}

// Helper to fill a slide with binary preview content
function populateBinaryPreview(slideElement, node, message, uint8Array = null) {
  const container = document.createElement('div');
  container.className = 'preview-binary-message';

  const title = document.createElement('h4');
  title.textContent = message || 'Binary/Unsupported File Format';
  container.appendChild(title);

  const sub = document.createElement('p');
  sub.textContent = 'Preview is not supported for this file type. You can extract and view it locally.';
  container.appendChild(sub);

  if (uint8Array) {
    const hexTitle = document.createElement('h5');
    hexTitle.textContent = 'Hex Dump (First 256 bytes):';
    hexTitle.style.marginTop = '1.5rem';
    hexTitle.style.alignSelf = 'flex-start';
    container.appendChild(hexTitle);

    const hexDump = document.createElement('pre');
    hexDump.className = 'preview-hex-dump';
    
    let hexText = '';
    const length = Math.min(uint8Array.length, 256);
    let lineHex = '';
    let lineAscii = '';

    for (let i = 0; i < length; i++) {
      if (i % 16 === 0) {
        if (i > 0) {
          hexText += `${lineHex.padEnd(48)}  ${lineAscii}\n`;
        }
        lineHex = `${i.toString(16).padStart(8, '0')}: `;
        lineAscii = '';
      }
      
      const byte = uint8Array[i];
      lineHex += `${byte.toString(16).padStart(2, '0')} `;
      lineAscii += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';
    }
    
    if (length > 0) {
      hexText += `${lineHex.padEnd(48)}  ${lineAscii}\n`;
    }
    
    hexDump.textContent = hexText;
    container.appendChild(hexDump);
  }

  slideElement.appendChild(container);
}

// Populate slide based on file category
async function loadSlideContent(node, slideElement) {
  const cat = getFileCategory(node.name);
  if (node.size > 5 * 1024 * 1024) {
    populateBinaryPreview(slideElement, node, 'File is too large to preview (> 5MB). Please download to view.');
  } else if (cat === 'image') {
    const blob = await node.jszipEntry.async('blob');
    const blobUrl = URL.createObjectURL(blob);
    slideElement.dataset.blobUrl = blobUrl;
    
    const img = document.createElement('img');
    img.src = blobUrl;
    img.className = 'preview-image';
    img.alt = node.name;
    
    const container = document.createElement('div');
    container.className = 'preview-image-container';
    container.appendChild(img);
    slideElement.appendChild(container);
  } else if (cat === 'code') {
    const text = await node.jszipEntry.async('string');
    const pre = document.createElement('pre');
    pre.className = 'preview-text';
    pre.textContent = text;
    slideElement.appendChild(pre);
  } else {
    const arr = await node.jszipEntry.async('uint8array');
    populateBinaryPreview(slideElement, node, null, arr);
  }
}

// Slide transition navigation
async function navigateToSlide(nextNode, direction = 'next') {
  if (!nextNode || nextNode === currentPreviewNode) return;
  
  const files = getPreviewableFiles();
  const index = files.indexOf(nextNode);
  if (index === -1) return;
  
  currentPreviewNode = nextNode;
  
  // Update detail labels immediately
  previewFilename.textContent = nextNode.name;
  previewFilesize.textContent = formatBytes(nextNode.size);
  previewIcon.innerHTML = getFileTypeSVG(false, nextNode.name);
  previewDownloadBtn.onclick = () => downloadSingleFile(nextNode);
  
  updatePreviewNavButtons(index, files.length);

  const newSlide = document.createElement('div');
  newSlide.className = 'preview-slide';
  
  if (direction === 'next') {
    newSlide.classList.add('slide-enter-right');
  } else {
    newSlide.classList.add('slide-enter-left');
  }
  
  showLoading('Loading Preview', `Decompressing ${nextNode.name} content...`, 30);
  try {
    await loadSlideContent(nextNode, newSlide);
    
    const currentSlide = previewBody.querySelector('.preview-slide.slide-active');
    
    // Append new slide
    previewBody.appendChild(newSlide);
    
    // Animate transition
    if (currentSlide) {
      currentSlide.classList.remove('slide-active');
      if (direction === 'next') {
        currentSlide.classList.add('slide-exit-left');
      } else {
        currentSlide.classList.add('slide-exit-right');
      }
      
      setTimeout(() => {
        if (currentSlide.dataset.blobUrl) {
          URL.revokeObjectURL(currentSlide.dataset.blobUrl);
        }
        currentSlide.remove();
      }, 400); // matches CSS transition duration
    }
    
    // Trigger reflow to start transition
    void newSlide.offsetWidth;
    newSlide.classList.remove('slide-enter-right', 'slide-enter-left');
    newSlide.classList.add('slide-active');
    
  } catch (err) {
    console.error(err);
    showToast('Could not load file preview.', 'error');
  } finally {
    hideLoading();
  }
}

async function triggerPreview(node) {
  if (!node.jszipEntry) return;

  const files = getPreviewableFiles();
  const index = files.indexOf(node);
  if (index === -1) return;
  
  currentPreviewNode = node;
  
  previewFilename.textContent = node.name;
  previewFilesize.textContent = formatBytes(node.size);
  previewIcon.innerHTML = getFileTypeSVG(false, node.name);
  previewBody.innerHTML = ''; // Clear existing slides
  
  previewDownloadBtn.onclick = () => downloadSingleFile(node);
  
  updatePreviewNavButtons(index, files.length);
  
  const slide = document.createElement('div');
  slide.className = 'preview-slide slide-active';
  
  showLoading('Loading Preview', `Decompressing ${node.name} content...`, 30);
  try {
    await loadSlideContent(node, slide);
    previewBody.appendChild(slide);
    openModal();
  } catch (err) {
    console.error(err);
    showToast('Could not load file preview.', 'error');
  } finally {
    hideLoading();
  }
}

function openModal() {
  previewModal.classList.remove('hidden');
}

function closeModal() {
  previewModal.classList.add('hidden');
  
  // Revoke any blob URL stored on slides and remove them
  const slides = previewBody.querySelectorAll('.preview-slide');
  slides.forEach(slide => {
    if (slide.dataset.blobUrl) {
      URL.revokeObjectURL(slide.dataset.blobUrl);
    }
    slide.remove();
  });
  
  if (activePreviewBlobUrl) {
    URL.revokeObjectURL(activePreviewBlobUrl);
    activePreviewBlobUrl = null;
  }
}

closePreviewBtn.addEventListener('click', closeModal);
previewModal.addEventListener('click', (e) => {
  if (e.target === previewModal) closeModal();
});

// Click handlers for next/prev buttons
previewPrevBtn.addEventListener('click', () => {
  const files = getPreviewableFiles();
  const currentIndex = files.indexOf(currentPreviewNode);
  if (currentIndex > 0) {
    navigateToSlide(files[currentIndex - 1], 'prev');
  }
});

previewNextBtn.addEventListener('click', () => {
  const files = getPreviewableFiles();
  const currentIndex = files.indexOf(currentPreviewNode);
  if (currentIndex < files.length - 1) {
    navigateToSlide(files[currentIndex + 1], 'next');
  }
});

// Touch swipe gesture implementation
let touchStartX = 0;
let touchEndX = 0;

previewBody.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

previewBody.addEventListener('touchend', (e) => {
  touchEndX = e.changedTouches[0].screenX;
  handleSwipe();
}, { passive: true });

function handleSwipe() {
  const swipeThreshold = 50; // min swipe distance in px
  const files = getPreviewableFiles();
  const currentIndex = files.indexOf(currentPreviewNode);
  
  if (touchEndX < touchStartX - swipeThreshold) {
    // Swiped left -> load next slide
    if (currentIndex < files.length - 1) {
      navigateToSlide(files[currentIndex + 1], 'next');
    }
  } else if (touchEndX > touchStartX + swipeThreshold) {
    // Swiped right -> load prev slide
    if (currentIndex > 0) {
      navigateToSlide(files[currentIndex - 1], 'prev');
    }
  }
}

// Window Keydown listener (Escape for close, Left/Right for nav)
window.addEventListener('keydown', (e) => {
  if (previewModal.classList.contains('hidden')) return;

  if (e.key === 'Escape') {
    closeModal();
  } else if (e.key === 'ArrowRight' || e.key === 'Right') {
    const files = getPreviewableFiles();
    const currentIndex = files.indexOf(currentPreviewNode);
    if (currentIndex < files.length - 1) {
      navigateToSlide(files[currentIndex + 1], 'next');
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'Left') {
    const files = getPreviewableFiles();
    const currentIndex = files.indexOf(currentPreviewNode);
    if (currentIndex > 0) {
      navigateToSlide(files[currentIndex - 1], 'prev');
    }
  }
});

// --- Progress & UI Overlays Helpers ---
function showLoading(title, message, progress = 0) {
  loadingTitle.textContent = title;
  loadingMessage.textContent = message;
  loadingProgress.style.width = `${progress}%`;
  loadingOverlay.classList.remove('hidden');
}

function updateLoadingProgress(progress, message = null) {
  loadingProgress.style.width = `${progress}%`;
  if (message) loadingMessage.textContent = message;
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// --- Toast Notifications ---
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let icon = '';
  if (type === 'success') {
    icon = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
  } else if (type === 'error') {
    icon = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="15" y1="9" x2="9" y2="15"></line>
        <line x1="9" y1="9" x2="15" y2="15"></line>
      </svg>
    `;
  } else if (type === 'warning') {
    icon = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
    `;
  }

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 5000);
}

// --- Stats and Math Helpers ---
function updateStats() {
  let fileCount = 0;
  let totalSize = 0;
  let totalCompSize = 0;

  function collectStats(node) {
    if (node.isFile) {
      fileCount++;
      totalSize += node.size;
      totalCompSize += node.compressedSize;
    }
    if (node.isDirectory) {
      node.children.forEach(collectStats);
    }
  }
  
  if (rootNode) collectStats(rootNode);

  statFilesEl.textContent = fileCount;
  statSizeEl.textContent = formatBytes(totalSize);
  statCompSizeEl.textContent = formatBytes(totalCompSize);
  
  const ratio = totalSize > 0 ? Math.round(((totalSize - totalCompSize) / totalSize) * 100) : 0;
  statRatioEl.textContent = `${ratio}%`;
}

function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
