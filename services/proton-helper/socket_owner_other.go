//go:build !linux

package main

import "os"

func ownedDirectory(info os.FileInfo) bool { return false }
