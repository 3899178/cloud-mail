package main

import (
	"net"
	"testing"
)

func TestResourceProviderLoopbackListener(t *testing.T) {
	t.Setenv("CLOUD_MAIL_RESOURCE_LOOPBACK", "1")
	listener, err := resourceProviderListener()
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || !address.IP.IsLoopback() || address.Port <= 0 {
		t.Fatal("fixture listener exposed outside loopback or did not bind")
	}
}

func TestResourceProviderInvalidListenerMode(t *testing.T) {
	t.Setenv("CLOUD_MAIL_RESOURCE_LOOPBACK", "public")
	listener, err := resourceProviderListener()
	if listener != nil {
		listener.Close()
		t.Fatal("invalid mode opened listener")
	}
	if err == nil {
		t.Fatal("invalid mode accepted")
	}
}
