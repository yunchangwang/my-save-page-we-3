# ZIP打包下载功能说明

## 功能概述

点击"停止监听并保存"按钮时，现在会自动将所有HTML快照和HAR文件打包成一个ZIP文件一次性下载，而不是分别下载多个文件。

## 使用方法

1. **开启监听**：勾选需要的选项（HTML抓取/接口抓取），点击"开始监听"
2. **浏览页面**：正常浏览网页，插件会自动抓取
3. **停止并保存**：点击"停止监听并保存"
4. **自动打包**：插件会自动：
   - 收集所有HTML快照
   - 收集HAR数据（如果开启了接口抓取）
   - 打包成ZIP文件
   - 一次性下载

## ZIP文件结构

```
capture-2026-05-14T10-30-00-123Z.zip
├── page1-2026-05-14T10-30-00.html
├── page2-2026-05-14T10-30-05.html
├── page3-2026-05-14T10-30-10.html
└── network-2026-05-14T10-30-15.har
```

## 技术实现

### 核心库
- **JSZip** v3.10.1 - 纯JavaScript ZIP库
- 大小：95KB（min版本）
- 无外部依赖

### 数据传递方案
- **IndexedDB 中转** - 完全避开消息大小限制，支持超大文件
- 在 background.js 中将 HAR 数据存储到 IndexedDB
- 在 capture-control.js 中从 IndexedDB 读取数据
- 使用完毕后自动清理 IndexedDB

### 代码修改

1. **capture-control.html**
   - 引入 `jszip.min.js`

2. **capture-control.js**
   - 新增 `downloadAsZip(htmlSnapshots, harData, folder)` 函数 - ZIP打包下载，支持HAR数据
   - 新增 `getHarFromIndexedDB()` 函数 - 从IndexedDB读取HAR数据
   - 新增 `clearHarFromIndexedDB()` 函数 - 清理IndexedDB中的HAR数据
   - 修改 `stopListeningAndSave()` - 使用IndexedDB获取HAR数据并打包
   - 保留原有的 `downloadSnapshot()` 函数 - 单独下载（备用）

3. **background.js**
   - 新增 `storeHarInIndexedDB` 消息处理 - 将HAR数据存储到IndexedDB
   - 新增 `exportHar` 消息处理 - 单独导出HAR文件（可选功能）

4. **jszip.min.js**
   - 新增文件，JSZip库

### IndexedDB vs 其他方案对比

| 方案 | 大小限制 | Service Worker支持 | 性能 | 复杂度 |
|------|---------|------------------|------|--------|
| IndexedDB | 无限制（数百MB） | ✅ 完全支持 | ⭐⭐⭐⭐ | 中 |
| Blob URL | 无限制 | ❌ 不支持 | ⭐⭐⭐⭐ | 低 |
| Data URL | ~2GB | ✅ 支持 | ⭐⭐⭐ | 低 |
| Message Passing | 64MB | ✅ 支持 | ⭐⭐ | 低 |

**选择 IndexedDB 的原因**：
- ✅ 在 Service Worker 环境中完全支持
- ✅ 无大小限制，支持超大HAR文件
- ✅ 持久化存储，跨上下文访问
- ✅ 事务性操作，数据安全
- ✅ 自动清理，不占用额外空间

## 优势

1. **用户体验更好**
   - 一次下载获取所有数据
   - 文件自动整理，不会散乱

2. **便于分享和归档**
   - ZIP文件便于传输
   - 文件结构清晰
   - 可以统一命名

3. **性能优化**
   - 减少下载次数
   - 避免浏览器下载管理器混乱

## 文件命名规则

- **ZIP文件**：`capture-YYYY-MM-DDTHH-MM-SS-sssZ.zip`
- **HTML文件**：保持原有文件名
- **HAR文件**：`network-YYYY-MM-DDTHH-MM-SS-sssZ.har`

## 兼容性

- Chrome 88+
- Manifest V3
- 支持大文件（受浏览器内存限制）

## 注意事项

1. **内存占用**：大量文件打包时会占用较多内存
2. **下载时间**：打包需要时间，大文件可能需要等待几秒
3. **文件大小**：单个ZIP文件建议不超过100MB

## 故障排除

### 问题：JSZip库未加载
**症状**：控制台提示 "JSZip 库未加载"
**解决**：确认 `jszip.min.js` 文件存在且被正确引入

### 问题：打包失败
**症状**：提示打包下载失败
**解决**：检查浏览器控制台的错误信息

### 问题：ZIP文件损坏
**症状**：下载的ZIP文件无法打开
**解决**：可能是网络中断或磁盘空间不足，请重试
