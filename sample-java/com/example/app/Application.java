package com.example.app;

import com.example.service.UserService;

public class Application {
    private final UserService userService;

    public Application(UserService userService) {
        this.userService = userService;
    }

    public void start() {
        userService.syncUsers();
    }
}
