class RepositoryApp {
    constructor() {
        this.token = localStorage.getItem("authToken");
        this.currentCategory = "all";
        this.files = [];
        this.init();
    }
    init() {
        if (this.token) {
            this.showMainPanel();
            this.loadFiles();
        } else {
            this.showLoginPanel();
        }
        this.bindEvents();
    }
    bindEvents() {
        document.getElementById("loginForm").addEventListener("submit", (e) => {
            e.preventDefault();
            this.login();
        });
        document.querySelectorAll(".tab-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                this.switchCategory(e.target.dataset.category);
            });
        });
        document.getElementById("uploadBtn").addEventListener("click", () => {
            this.showUploadModal();
        });
        document.getElementById("uploadForm").addEventListener("submit", (e) => {
            e.preventDefault();
            this.uploadFile();
        });
        document.getElementById("searchInput").addEventListener("input", (e) => {
            this.searchFiles(e.target.value);
        });
        document.getElementById("logoutBtn").addEventListener("click", () => {
            this.logout();
        });
        document.getElementById("uploadCategory").addEventListener("change", (e) => {
            const privacyFields = document.getElementById("privacyFields");
            if (e.target.value === "privacy") {
                privacyFields.classList.remove("hidden");
            } else {
                privacyFields.classList.add("hidden");
            }
        });
    }
    async login() {
        const username = document.getElementById("username").value;
        const password = document.getElementById("password").value;
        try {
            const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password })
            });
            const data = await response.json();
            if (data.code === 200) {
                this.token = data.token;
                localStorage.setItem("authToken", this.token);
                this.showMainPanel();
                this.loadFiles();
            } else {
                alert("登入失敗：" + data.message);
            }
        } catch (error) {
            alert("登入錯誤：" + error.message);
        }
    }
    logout() {
        this.token = null;
        localStorage.removeItem("authToken");
        this.showLoginPanel();
    }
    showLoginPanel() {
        document.getElementById("loginPanel").classList.remove("hidden");
        document.getElementById("mainPanel").classList.add("hidden");
    }
    showMainPanel() {
        document.getElementById("loginPanel").classList.add("hidden");
        document.getElementById("mainPanel").classList.remove("hidden");
        document.getElementById("welcomeUser").textContent = "歡迎使用私人倉庫";
    }
    switchCategory(category) {
        this.currentCategory = category;
        document.querySelectorAll(".tab-btn").forEach(btn => {
            btn.classList.remove("active");
        });
        document.querySelector(`[data-category="${category}"]`).classList.add("active");
        this.filterFiles();
    }
    async loadFiles() {
        try {
            const categories = ["web", "app", "image", "mobile", "note", "privacy"];
            this.files = [];
            for (const category of categories) {
                const response = await fetch(`/api/files/${category}/list`, {
                    headers: { "Authorization": `Bearer ${this.token}` }
                });
                const data = await response.json();
                if (data.code === 200) {
                    this.files.push(...data.data);
                }
            }
            this.filterFiles();
        } catch (error) {
            alert("載入檔案失敗：" + error.message);
        }
    }
    filterFiles() {
        let filteredFiles = this.files;
        if (this.currentCategory !== "all") {
            filteredFiles = this.files.filter(file => file.category === this.currentCategory);
        }
        this.renderFiles(filteredFiles);
    }
    renderFiles(files) {
        const grid = document.getElementById("fileGrid");
        if (files.length === 0) {
            grid.innerHTML = "<div style=\"text-align:center;padding:2rem;color:#666;\">沒有找到檔案</div>";
            return;
        }
        grid.innerHTML = files.map(file => `
            <div class="file-card" onclick="app.viewFile('${file.category}', '${file.id}')">
                <div class="file-category">${this.getCategoryName(file.category)}</div>
                <h4>${file.title || file.original_name}</h4>
                <p>${file.ai_summary || "無描述"}</p>
                <div style="margin-top:0.5rem;font-size:0.8rem;color:#999;">
                    ${new Date(file.created_at).toLocaleDateString()}  ${this.formatFileSize(file.size)}
                </div>
            </div>
        `).join("");
    }
    async viewFile(category, id) {
        try {
            const response = await fetch(`/api/files/${category}/${id}`, {
                headers: { "Authorization": `Bearer ${this.token}` }
            });
            const data = await response.json();
            if (data.code === 200) {
                alert(`檔案：${data.data.title || data.data.original_name}\n分類：${this.getCategoryName(data.data.category)}\n大小：${this.formatFileSize(data.data.size)}`);
            }
        } catch (error) {
            alert("載入檔案詳情失敗：" + error.message);
        }
    }
    showUploadModal() {
        document.getElementById("uploadModal").classList.remove("hidden");
    }
    closeUploadModal() {
        document.getElementById("uploadModal").classList.add("hidden");
        document.getElementById("uploadForm").reset();
    }
    async uploadFile() {
        const formData = new FormData();
        const category = document.getElementById("uploadCategory").value;
        const mainFile = document.getElementById("mainFile").files[0];
        const thumbFile = document.getElementById("thumbFile").files[0];
        if (!mainFile) {
            alert("請選擇要上傳的檔案");
            return;
        }
        formData.append("file", mainFile);
        if (thumbFile) formData.append("thumb", thumbFile);
        formData.append("title", document.getElementById("uploadTitle").value);
        formData.append("description", document.getElementById("uploadDescription").value);
        if (category === "privacy") {
            formData.append("url", document.getElementById("uploadUrl").value);
            formData.append("account", document.getElementById("uploadAccount").value);
            formData.append("password", document.getElementById("uploadPassword").value);
        }
        try {
            const response = await fetch(`/api/files/${category}/upload`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${this.token}` },
                body: formData
            });
            const data = await response.json();
            if (data.code === 200) {
                alert("上傳成功！");
                this.closeUploadModal();
                this.loadFiles();
            } else {
                alert("上傳失敗：" + data.message);
            }
        } catch (error) {
            alert("上傳錯誤：" + error.message);
        }
    }
    searchFiles(query) {
        if (!query.trim()) {
            this.filterFiles();
            return;
        }
        let filtered = this.files.filter(file => 
            (file.title || "").toLowerCase().includes(query.toLowerCase()) ||
            (file.ai_summary || "").toLowerCase().includes(query.toLowerCase()) ||
            (file.original_name || "").toLowerCase().includes(query.toLowerCase())
        );
        if (this.currentCategory !== "all") {
            filtered = filtered.filter(file => file.category === this.currentCategory);
        }
        this.renderFiles(filtered);
    }
    getCategoryName(category) {
        const names = { web: "網頁", app: "應用", image: "映像", mobile: "移動", note: "記事", privacy: "隱私" };
        return names[category] || category;
    }
    formatFileSize(bytes) {
        if (!bytes) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }
}
let app;
document.addEventListener("DOMContentLoaded", () => {
    app = new RepositoryApp();
});
function closeUploadModal() {
    app.closeUploadModal();
}
