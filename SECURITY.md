# 凭据与安全

STREE 需要部署者自行配置模型 API、高德服务和可选的数据库。请将真实凭据放在未被 Git 跟踪的本地配置中。

## 本地防护

安装 [Gitleaks](https://github.com/gitleaks/gitleaks)，在仓库根目录启用推送前检查：

```bash
git config --local core.hooksPath .githooks
```

检查会拒绝已跟踪的真实 `.env` 和模型凭据配置，并扫描本地全部可达提交。缺少扫描器或检测失败时会阻止推送；输出中的密钥会被隐藏。请勿跳过检查。

GitHub Actions 也会在推送和 Pull Request 时扫描完整可达历史。GitHub 密钥扫描与推送保护需由仓库管理员在安全设置中启用；它们无法识别所有凭据格式。

## 配置与分享

- 示例配置只能包含空值或占位符。
- 不要提交 `.env`、`provider-settings.json`、数据库副本、私钥或带凭据的备份。
- 前端 `VITE_*` 变量会进入浏览器构建产物。高德 JS Key 应按实际访问地址限制权限；模型密钥与高德 Web 服务 Key 必须留在后端。
- 分享日志、截图或错误报告前，移除 API Key、认证头、数据库密码与私人行程信息。

## 发现泄露后

先在对应服务撤销或更换凭据，并更新所有实际使用它的部署。删除仓库文件或清理 Git 历史都不能让旧密钥失效。

历史清理涉及提交重写。协作者应重新克隆仓库，避免把旧历史再次合入。历史提交可能仍存在于其他人的克隆或 GitHub 缓存中；必要时按 [GitHub 官方指引](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)联系 GitHub Support。

请勿把实际凭据贴到公开 Issue。联系方式见 [项目 README](README.md#联系与合作)。
