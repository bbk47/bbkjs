#!/bin/bash

# 定义源目录和目标目录
source_dir="./"
target_dir="root@152.136.155.34:/root/github/bbk"

# 使用rsync命令进行同步
rsync -avz --exclude='.git/' --exclude='node_modules/' -e ssh $source_dir $target_dir 