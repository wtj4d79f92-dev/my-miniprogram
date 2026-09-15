# AGENTS.md

## 项目概述
微信小程序，使用原生开发。核心页面文件在 pages/ 目录下。

## 关键命令
- 无特殊构建命令，代码改动直接保存即可。
- 代码推送：git add . && git commit -m "描述" && git push

## 硬性约束
- 不要修改 project.config.json 和 app.json 中的基础配置。
- 修改 pages/ 下代码后，优先检查对应页面的 js 和 wxml 是否同步更新。
